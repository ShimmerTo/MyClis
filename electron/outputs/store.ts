import { randomUUID } from 'crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { CH } from '../../shared/types'
import type { OutputArtifact, OutputBundle, OutputMedia, OutputProducer, PresentRequest, TerminalInfo } from '../../shared/types'
import type { TerminalManager } from '../pty/terminals'
import { getAdapter } from '../cli/registry'
import { IMAGES, toDataUrl } from '../media'

type Emitter = (channel: string, payload: unknown) => void
const MARKDOWN = new Set(['.md', '.markdown'])
const URL_RE = /^https?:\/\//i

export class OutputStore {
  private bundles = new Map<string, OutputBundle[]>()

  constructor(private terminals: TerminalManager, private emit: Emitter) {}

  publish(
    request: PresentRequest,
    source: OutputBundle['source'] = 'main-cli',
    sessionId?: string,
    producer?: OutputProducer
  ): OutputBundle {
    const given = request.workDir.trim()
    const want = (sessionId ?? request.session)?.trim()
    if (!given && !want) throw new Error('缺少 workDir（发布地址也没带会话 id）')
    // 会话标识命中就用它，产物根目录也以该会话的工作目录为准；否则按目录回退
    const main = this.terminals.mainForWorkDir(given, want)
    const workDir = resolve(main.workDir)
    // 同一路径已在输出区就不再重复成组：主 CLI 汇总时把子 CLI 结果文件二次 /present 会撞到这里
    const existing = this.list(main.id)
    const known = new Set(existing.flatMap((b) => b.artifacts.map((a) => a.path)))
    const artifacts = request.files
      .slice(0, 50)
      .map((file) => this.resolveArtifact(workDir, file.path, file.label))
      .filter((a) => !known.has(a.path))
    if (artifacts.length === 0) {
      // 全是已发布过的路径：幂等返回最近一组，不新建、不覆盖既有来源与命名
      const last = existing.at(-1)
      if (last) return last
      throw new Error('files 至少要包含一个 Markdown、图片或网址')
    }
    const bundle: OutputBundle = {
      id: randomUUID(),
      sessionId: main.id,
      workDir,
      title: request.title?.trim() || artifacts[0].label,
      createdAt: Date.now(),
      source,
      // 子 CLI 发布时由调用方传入它自己的档案，主 CLI 发布就看主会话自己
      producer: producer ?? this.producerOf(main),
      artifacts
    }
    const list = [...existing, bundle].slice(-100)
    this.bundles.set(main.id, list)
    this.emit(CH.outputsChanged, { sessionId: main.id, bundles: list })
    return bundle
  }

  publishReviewer(
    parentSessionId: string,
    input: { title: string; file: string; label: string; producer: OutputProducer }
  ): void {
    const main = this.terminals.get(parentSessionId)
    if (!main) return
    this.publish(
      { workDir: main.workDir, title: input.title, files: [{ path: input.file, label: input.label }] },
      'reviewer',
      parentSessionId,
      input.producer
    )
  }

  /** 产物列表第二行要用的产生者身份：模型留空时由渲染层显示「默认」 */
  private producerOf(info: TerminalInfo): OutputProducer {
    const adapter = info.cli === 'shell' ? undefined : getAdapter(info.cli)
    return { cliLabel: adapter?.label ?? info.cli, model: info.model?.trim() || undefined }
  }

  /** 输出只属于产生它的那个会话：不做跨会话/跨启动的落盘回填，否则新会话会顶出别人的文档 */
  list(sessionId: string): OutputBundle[] {
    const hit = this.bundles.get(sessionId) ?? []
    return hit.map((item) => ({ ...item, artifacts: item.artifacts.map((a) => ({ ...a })) }))
  }

  read(sessionId: string, artifactId: string): { media: OutputMedia; text?: string; dataUrl?: string } {
    const bundle = this.list(sessionId).find((item) => item.artifacts.some((a) => a.id === artifactId))
    const artifact = bundle?.artifacts.find((item) => item.id === artifactId)
    if (!bundle || !artifact) throw new Error('输出文件不存在')
    if (artifact.media === 'url') return { media: 'url', text: artifact.path }
    const checked = this.resolveArtifact(bundle.workDir, artifact.path, artifact.label)
    if (checked.media === 'markdown') return { media: 'markdown', text: readFileSync(checked.path, 'utf-8') }
    return { media: 'image', dataUrl: toDataUrl(checked.path) }
  }

  /** 资源管理器定位用：返回产物在本机的绝对路径（渲染层不自己拼路径）；网址产出没有本地文件 */
  locate(sessionId: string, artifactId: string): string {
    const bundle = this.list(sessionId).find((item) => item.artifacts.some((a) => a.id === artifactId))
    const artifact = bundle?.artifacts.find((item) => item.id === artifactId)
    if (!artifact) throw new Error('输出文件不存在')
    if (artifact.media === 'url') throw new Error('网址产出没有本地文件')
    return artifact.path
  }

  /** Markdown 内嵌图片：相对路径以该 md 所在目录为基准，且仍不得越出工作目录。 */
  readAsset(sessionId: string, artifactId: string, src: string): { dataUrl: string } {
    const bundle = this.list(sessionId).find((item) => item.artifacts.some((a) => a.id === artifactId))
    const artifact = bundle?.artifacts.find((item) => item.id === artifactId)
    if (!bundle || !artifact || artifact.media !== 'markdown') throw new Error('输出文件不存在或不是 Markdown')
    return { dataUrl: toDataUrl(this.resolveEmbeddedImage(bundle.workDir, dirname(artifact.path), src)) }
  }

  private resolveArtifact(workDir: string, given: string, label?: string): OutputArtifact {
    // 网址产出：跳过文件校验
    if (URL_RE.test(given)) {
      return { id: randomUUID(), label: label?.trim() || given, path: given, media: 'url', bytes: 0, mtime: Date.now() }
    }
    const root = realpathSync(workDir)
    const candidate = resolve(isAbsolute(given) ? given : join(workDir, given))
    if (!existsSync(candidate)) throw new Error(`输出文件不存在：${candidate}`)
    const actual = realpathSync(candidate)
    const rel = relative(root, actual)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`输出文件必须位于当前工作目录内：${candidate}`)
    }
    const stat = statSync(actual)
    if (!stat.isFile()) throw new Error(`输出路径不是文件：${candidate}`)
    const ext = extname(actual).toLowerCase()
    const media = MARKDOWN.has(ext) ? 'markdown' : IMAGES.has(ext) ? 'image' : undefined
    if (!media) throw new Error(`不支持的输出文件类型：${ext || '无扩展名'}`)
    const cap = media === 'markdown' ? 5 * 1024 * 1024 : 20 * 1024 * 1024
    if (stat.size > cap) throw new Error(`输出文件过大：${candidate}`)
    return { id: randomUUID(), label: label?.trim() || basename(actual), path: actual, media, bytes: stat.size, mtime: stat.mtimeMs }
  }

  private resolveEmbeddedImage(workDir: string, baseDir: string, src: string): string {
    const raw = src.split(/[?#]/)[0].trim()
    let clean = raw
    try {
      clean = decodeURIComponent(raw)
    } catch {
      // 非法转义时按原样处理，交给边界校验兜底
    }
    if (!clean) throw new Error('图片路径为空')
    if (isAbsolute(clean) || /^[a-z][a-z0-9+.-]*:/i.test(clean)) {
      throw new Error(`只支持 Markdown 内的相对图片路径：${raw}`)
    }
    const candidate = resolve(baseDir, clean)
    if (!existsSync(candidate)) throw new Error(`图片不存在：${clean}`)
    const root = realpathSync(workDir)
    const actual = realpathSync(candidate)
    const rel = relative(root, actual)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`图片必须位于当前工作目录内：${clean}`)
    }
    if (!statSync(actual).isFile()) throw new Error(`图片路径不是文件：${clean}`)
    if (!IMAGES.has(extname(actual).toLowerCase())) throw new Error(`不支持的图片类型：${clean}`)
    if (statSync(actual).size > 20 * 1024 * 1024) throw new Error(`图片过大：${clean}`)
    return actual
  }
}
