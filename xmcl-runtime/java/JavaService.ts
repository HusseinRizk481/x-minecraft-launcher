import { JavaVersion } from '@xmcl/core'
import { fetchJavaRuntimeManifest, installJavaRuntimeTask, parseJavaVersion, resolveJava, scanLocalJava } from '@xmcl/installer'
import { JavaService as IJavaService, Java, JavaRecord, JavaSchema, JavaServiceKey, JavaState, MutableState, Settings } from '@xmcl/runtime-api'
import { chmod, ensureFile, readFile } from 'fs-extra'
import { dirname, join } from 'path'
import { URL } from 'url'
import { Inject, LauncherAppKey, PathResolver, kGameDataPath } from '~/app'
import { GFW } from '~/gfw'
import { JavaValidation, validateJavaPath } from '~/java'
import { kDownloadOptions } from '~/network'
import { ExposeServiceKey, ServiceStateManager, Singleton, StatefulService } from '~/service'
import { getApiSets, shouldOverrideApiSet } from '~/settings'
import { TaskFn, kTaskExecutor } from '~/task'
import { LauncherApp } from '../app/LauncherApp'
import { readdirIfPresent } from '../util/fs'
import { requireString } from '../util/object'
import { SafeFile, createSafeFile } from '../util/persistance'
import { ensureClass, getJavaArch } from './detectJVMArch'

@ExposeServiceKey(JavaServiceKey)
export class JavaService extends StatefulService<JavaState> implements IJavaService {
  protected readonly config: SafeFile<JavaSchema>

  constructor(@Inject(LauncherAppKey) app: LauncherApp,
    @Inject(Settings) private settings: Settings,
    @Inject(ServiceStateManager) store: ServiceStateManager,
    @Inject(kTaskExecutor) private submit: TaskFn,
    @Inject(GFW) private gfw: GFW,
    @Inject(kGameDataPath) private getPath: PathResolver,
  ) {
    super(app, () => store.registerStatic(new JavaState(), JavaServiceKey), async () => {
      const data = await this.config.read()
      const valid = data.all.filter(l => typeof l.path === 'string').map(a => ({ ...a, valid: true }))
      this.log(`Loaded ${valid.length} java from cache.`)
      this.state.javaUpdate(valid)

      this.refreshLocalJava()

      this.state.subscribeAll(() => {
        this.config.write(this.state)
      })

      ensureClass(this.app).catch((e) => {
        this.error(e)
      })
    })
    this.config = createSafeFile(this.getAppDataPath('java.json'), JavaSchema, this, [getPath('java.json')])
  }

  removeJava(javaPath: string): Promise<void> {
    this.state.javaRemove({ path: javaPath, majorVersion: 0, version: '', valid: false })
    return Promise.resolve()
  }

  async getJavaState(): Promise<MutableState<JavaState>> {
    await this.initialize()
    return this.state
  }

  getInternalJavaLocation(version: Pick<JavaVersion, 'component'>) {
    return this.app.platform.os === 'osx'
      ? this.getPath('jre', version.component, 'jre.bundle', 'Contents', 'Home', 'bin', 'java')
      : this.getPath('jre', version.component, 'bin',
        this.app.platform.os === 'windows' ? 'java.exe' : 'java')
  }

  getJavaForVersion(javaVersion: JavaVersion, validOnly = false) {
    const expectedJava = this.state.all.find(j => j.majorVersion === javaVersion.majorVersion && (!validOnly || j.valid))
    return expectedJava
  }

  /**
   * Get java preferred java 8 for installing forge or other purpose. (non launching Minecraft)
   */
  getPreferredJava() {
    return this.state.all.find(j => j.valid && j.majorVersion === 8) || this.state.all.find(j => j.valid)
  }

  /**
   * Install a default jdk 8 to the a preserved location. It'll be installed under your launcher root location `jre` folder
   */
  @Singleton()
  async installDefaultJava(target?: JavaVersion) {
    if (!target) {
      target = {
        majorVersion: 8,
        component: 'jre-legacy',
      }
    }
    const location = this.getInternalJavaLocation(target)
    this.log(`Try to install official java ${target} to ${location}`)
    let apiHost: string[] | undefined
    if (shouldOverrideApiSet(this.settings, this.gfw.inside)) {
      const apis = getApiSets(this.settings)
      apiHost = apis.map(a => new URL(a.url).hostname)
    }
    const downloadOptions = await this.app.registry.get(kDownloadOptions)
    const manifest = await fetchJavaRuntimeManifest({
      apiHost,
      ...downloadOptions,
      target: target.component,
    })
    this.log(`Install jre runtime ${target.component} (${target.majorVersion}) ${manifest.version.name} ${manifest.version.released}`)
    const dest = this.getPath('jre', target.component)

    if (!apiHost) {
      const apis = getApiSets(this.settings)
      apiHost = apis.map(a => new URL(a.url).hostname)

      if (!shouldOverrideApiSet(this.settings, this.gfw.inside)) {
        apiHost.unshift('https://launcher.mojang.com')
      }
    }

    const task = installJavaRuntimeTask({
      manifest,
      apiHost,
      destination: dest,
      ...downloadOptions,
    }).setName('installJre', { version: target.majorVersion })
    await ensureFile(location)
    await this.submit(task)
    if (this.app.platform.os !== 'windows') {
      await chmod(location, 0o765)
    }
    this.log(`Successfully install java internally ${location}`)
    return await this.resolveJava(location)
  }

  async validateJavaPath(javaPath: string): Promise<JavaValidation> {
    const result = await validateJavaPath(javaPath)

    const found = this.state.all.find(java => java.path === javaPath)
    if (found && result !== JavaValidation.Okay) {
      this.state.javaUpdate({ ...found, valid: false })
    }

    return result
  }

  /**
   * Resolve java info. If the java is not known by launcher. It will cache it into the launcher java list.
   */
  async resolveJava(javaPath: string): Promise<undefined | Java> {
    requireString(javaPath)

    this.log(`Try resolve java ${javaPath}`)
    const validation = await validateJavaPath(javaPath)

    const found = this.state.all.find(java => java.path === javaPath)
    if (found) {
      if (validation !== JavaValidation.Okay) {
        // invalidate java
        if (found.valid) {
          this.state.javaUpdate({ ...found, valid: false })
        }
      } else {
        if (!found.valid) {
          this.state.javaUpdate({ ...found, valid: true })
        }
        this.log(`Found a cached & ${found.valid ? 'valid' : 'invalid'} java ${found.version} in ${javaPath}`)
      }
      return found
    }

    if (validation === JavaValidation.NotExisted) {
      // just cannot resolve java
      this.log(`Skip resolve missing java ${javaPath}`)
      return undefined
    }

    const java = await resolveJava(javaPath)
    if (java && validation === JavaValidation.Okay) {
      this.log(`Resolved java ${java.version} in ${javaPath}`)

      this.state.javaUpdate({ ...java, valid: true, arch: await getJavaArch(this.app, java.path) })
    } else {
      const home = dirname(dirname(javaPath))
      const releaseData = await readFile(join(home, 'release'), 'utf-8')
      const javaVersion = releaseData.split('\n').map(l => l.split('=')).find(v => (v[0] === 'JAVA_VERSION'))?.[1]
      if (javaVersion) {
        const parsedJavaVersion = parseJavaVersion(javaVersion)
        if (parsedJavaVersion) {
          this.log(`Resolved invalid java ${parsedJavaVersion.version} in ${javaPath}`)
          this.state.javaUpdate({ ...parsedJavaVersion, path: javaPath, valid: false })
        } else {
          this.log(`Resolved invalid unknown version java in ${javaPath}`)
          this.state.javaUpdate({ valid: false, path: javaPath, version: '', majorVersion: 0 })
        }
      } else {
        this.log(`Resolved invalid unknown version java in ${javaPath}`)
        this.state.javaUpdate({ valid: false, path: javaPath, version: '', majorVersion: 0 })
      }
    }
    return java
  }

  /**
   * scan local java locations and cache
   */
  @Singleton()
  async refreshLocalJava(force?: boolean) {
    if (this.state.all.length === 0 || force) {
      this.log('Force update or no local cache found. Scan java through the disk.')
      const commonLocations = [] as string[]
      if (this.app.platform.os === 'windows') {
        let files = await readdirIfPresent('C:\\Program Files\\Java')
        files = files.map(f => join('C:\\Program Files\\Java', f, 'bin', 'java.exe'))
        commonLocations.push(...files)
      }
      const javas = await scanLocalJava(commonLocations)
      const infos = await Promise.all(javas.map(async (j) => ({ ...j, valid: true, arch: await getJavaArch(this.app, j.path) })))

      this.log(`Found ${infos.length} java.`)
      this.state.javaUpdate(infos)
    } else {
      this.log(`Re-validate cached ${this.state.all.length} java locations.`)
      const javas: JavaRecord[] = []
      for (let i = 0; i < this.state.all.length; ++i) {
        const result = await resolveJava(this.state.all[i].path)
        if (result) {
          javas.push({ ...result, valid: true, arch: this.state.all[i].arch ?? await getJavaArch(this.app, result.path) })
        } else {
          javas.push({ ...this.state.all[i], valid: false })
        }
      }
      const invalided = javas.filter(j => !j.valid).length
      if (invalided !== 0) {
        this.log(`Invalidate ${invalided} java!`)
        for (const i of javas.filter(j => !j.valid)) {
          this.log(i.path)
        }
      }
      this.state.javaUpdate(javas)
    }

    const cached = await readdirIfPresent(this.getPath('jre'))
    for (const component of cached) {
      if (component.startsWith('.')) continue
      const local = this.getInternalJavaLocation({ component })
      if (!this.state.all.map(j => j.path).some(p => p === local)) {
        this.resolveJava(local)
      }
    }
  }
}
