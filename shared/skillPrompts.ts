import type { CommandConfig, InjectionConfig, SkillPrompts } from './types'

/**
 * 三个触发命令注入给主 CLI 的默认正文（设置页可覆盖，留空即用它）。
 * 这里只写"要做什么"；怎么触发（curl + bridge 地址）由 skills/templates 固定附加，
 * 用户在设置页改正文也改不坏那一段。放 shared 是因为主进程要渲染、设置页要显示与"恢复默认"。
 * 占位符见 PLACEHOLDER_HINT。
 */
export const DEFAULT_PROMPTS: SkillPrompts = {
  design: `请根据用户需求和当前代码库设计可执行的实现方案：
{query}
先判断是否存在会改变实现范围、产品行为、兼容策略或数据安全的边界与决策不清。如有，必须先向用户提问并停止当前回复；在用户答复前不得生成正式方案文档，也不得安排其它 CLI 校验。普通细节可以采用明确假设，但必须写入文档。
边界清楚后，将需求、现状、修改范围、实施步骤、关键决策、风险和验证方法写入方案设计文档，再交给已配置的校验 CLI。
为每个被调起的校验 CLI 分别确定它要重点校验什么、要产出什么形式的结论；方案与结论都以工作目录内的 markdown 文档留痕。`,

  write: `请先根据用户需求，把开发工作按模块拆成可以并行实施的编码任务：
{query}
按下一节列出的代码编写 CLI 清单逐个拆分：一个 CLI 一份独立开发文档，尽量按照前后端分工，如果有多项目则按照不同项目进行分工。
如果是跨项目，那么分工的CLI需要指定其开发任务所在目录。
每份开发文档都要写明：目标、验收标准、允许改动的路径（范围内）、明确禁止改动的路径与目录（范围外，任何越界改动都算该任务失败）、相关文件、实施步骤、验证命令，以及这份产出交付后主 CLI 要怎么继续。
只列出一个代码编写 CLI 时，只出一份开发文档并覆盖全部范围，不要拆分。
与其它 CLI 的一切沟通都必须落在工作目录内的 markdown 文档里留痕，不得靠终端输出或隐含约定传递任务内容。`,

  review: `请先根据用户需求、当前代码改动和已有设计资料整理代码检查文档：
{query}
将验收标准、设计约束、改动范围、重点文件、已运行验证和已知风险写入文档，再交给已配置的检查 CLI。
每个被调起的检查 CLI 都要独立、完整地检查一遍：检查范围是全部改动与相关代码，检查项是下面列出的全部检查点，这两者对所有 CLI 完全相同——不得按模块、文件、功能或检查维度分工，不得为某个 CLI 单独划分范围或指定检查重点，不得因为别的 CLI 也会看就跳过任何一处，也不得假定别处已被覆盖。
检查依据与结论都以工作目录内的 markdown 文档留痕。
注意：重点检查点为死循环，新增编辑删除是否越界，代码结构（文件划分）是否合理，结构是否合理，高内聚低耦合（是否利于扩展）。`
}

export const PLACEHOLDER_HINT = '{query} 用户指令'

export const DEFAULT_COMMANDS: CommandConfig[] = [
  { id: 'builtin-design', name: 'myclis-design', enabled: true, prompt: '', builtinKind: 'design' },
  { id: 'builtin-write', name: 'myclis-code', enabled: true, prompt: '', builtinKind: 'write' },
  { id: 'builtin-review', name: 'myclis-review', enabled: true, prompt: '', builtinKind: 'review' }
]

/** 启动注入清单（设置页只给说明与开关，正文固定生成），默认全部启用 */
export const DEFAULT_INJECTIONS: InjectionConfig[] = [
  {
    id: 'builtin-present',
    name: '输出展示协议',
    description:
      '让主 CLI 知道本会话 id，以及可以把工作目录内的 Markdown、图片或 http(s) 网址发布到应用底部输出区，供用户直接查看；启动会话时追加到它的系统提示，不写进命令文件。',
    enabled: true,
    builtinKind: 'present'
  }
]

/**
 * 启动注入的正文。要原样拼进 CLI 启动行，所以必须是单行且不含单引号、双引号、
 * 反斜杠和百分号——powershell / git-bash / cmd 的引号规则都过不了这些字符。
 * 会话 id 直接拼进 URL：模型逐字抄这串地址，比在 JSON 里另填字段可靠。
 */
export function buildPresentInjection(bridgeUrl: string, sessionId: string): string {
  return [
    `MyClis 输出展示协议：本会话 id 是 ${sessionId}（发布输出、下发子任务都要原样使用，不要改写）。`,
    '需要给用户看的内容不要只留在终端里，把要展示的东西写成工作目录内的 Markdown 或图片文件（也可以直接用 http/https 网址），',
    '再创建 .clichilds/present.json：workDir 填当前工作目录的绝对路径，title 填输出标题，files 是数组，每项给出工作目录内的 Markdown/图片路径或 http(s) 网址，可用 label 指定列表显示名；',
    `然后执行 curl.exe -sS -X POST -H content-type:application/json --data-binary @.clichilds/present.json ${bridgeUrl}/present/${sessionId}，产物会出现在应用底部的输出区。`,
    '只允许提交工作目录内的文件或 http(s) 网址，不要把正文内容或图片数据塞进 JSON。'
  ].join('')
}
