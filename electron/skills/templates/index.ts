import { MAX_CHILD_RETRIES } from '../../../shared/types'
import type { BuiltinCommandKind, CommandConfig } from '../../../shared/types'
import { DEFAULT_PROMPTS } from '../../../shared/skillPrompts'

/** 一个本次会被拉起的执行 CLI；id 就是 targets 里要填的 profileId。 */
export interface SkillAssignment {
  id: string
  label: string
}

export interface SkillCtx {
  bridgeUrl: string
  commands: CommandConfig[]
  /** 各角色本次会被拉起的 CLI 清单，由实时配置解析，不能落到用户可编辑的正文里 */
  assignments: Record<BuiltinCommandKind, SkillAssignment[]>
}

export interface SkillFile {
  name: string
  description: string
  body: string
}

type SkillKey = BuiltinCommandKind

const REQUEST_DIR = '.clichilds/requests'
const RESULT_DIR = '.clichilds/results'

const WHAT: Record<SkillKey, string> = {
  design: '方案校验',
  write: '代码编写',
  review: '代码检查'
}

const MASTER_DOC: Record<SkillKey, string> = {
  design: '[需求名称]-方案设计文档.md',
  write: '[需求名称]-代码开发任务-总览.md',
  review: '[需求名称]-代码检查文档.md'
}

const DESCRIPTIONS: Record<SkillKey, string> = {
  design: '方案设计与校验：先澄清关键边界，生成方案文档，再按当前会话配置分发 CLI 校验。',
  write: '代码编写：按模块生成开发任务文档，再按当前会话配置分发 CLI 实施。',
  review: '代码检查：生成检查文档，再按当前会话配置分发 CLI 审查。'
}

function render(tpl: string): string {
  return tpl.replace(/\{query\}/g, '$ARGUMENTS').replace(/\{resultDir\}/g, RESULT_DIR)
}

/**
 * 分配这一段的口径：只有代码编写按 CLI 拆分范围，其余角色每个 CLI 都覆盖全部内容。
 * 检查类任务不能出现「分别确定每个 CLI 的任务/重点」这类框架——只要让主 CLI 逐个 CLI 去定任务，
 * 它就会按 CLI 把范围切开；这里只允许写「所有 CLI 共用同一条口径」。
 */
const ASSIGN_LINE: Record<SkillKey, string> = {
  design:
    '   接着为本次要拉起的每一个方案校验 CLI 分别确定：它的任务指令是什么、要它重点看什么、它要产出什么形式的结论。',
  write: '',
  review:
    '   接着写清交给每个代码检查 CLI 的任务指令：所有 CLI 共用同一条口径——检查全部改动与全部检查点，不为任何 CLI 单独划分范围、模块、文件或检查重点。'
}

/** targets[].task 的占位说明：检查类任务的范围是全部改动，不是分给它的那一块。 */
const TASK_HINT: Record<SkillKey, string> = {
  design: '交给该 CLI 的完整任务指令：目标、范围内改动、禁止越界的范围、要产出什么',
  write: '交给该 CLI 的完整任务指令：目标、范围内改动、禁止越界的范围、要产出什么',
  review: '交给该 CLI 的完整任务指令：目标、全部改动与全部检查项（每个 CLI 完全相同，不分工）'
}

/** 交付文档这一段的差异：代码编写按 CLI 拆分，其余角色共用一份主文档。 */
function docSteps(kind: SkillKey, list: SkillAssignment[]): string[] {
  if (kind !== 'write') {
    return [
      `1. 先完成上述分析，在当前工作目录的 \`${REQUEST_DIR}\` 下写入 \`${MASTER_DOC[kind]}\`。文件名要用简短、可读的真实需求名替换方括号。`,
      '   这份文档是本次任务的留痕，也是所有被调起 CLI 唯一的输入；文件名、路径稍后要原样填进请求里。',
      ASSIGN_LINE[kind]
    ]
  }
  return [
    `1. 先完成上述分析，在当前工作目录的 \`${REQUEST_DIR}\` 下写入总览 \`${MASTER_DOC[kind]}\`：需求、模块清单、各模块由哪个 CLI 负责、范围矩阵、依赖顺序。文件名要用简短、可读的真实需求名替换方括号。`,
    '   再按上面的清单逐个写开发文档，一个 CLI 一份：',
    ...list.map(
      (item) => `   - ${item.label} → \`${REQUEST_DIR}/[需求名称]-代码开发任务-${item.label}.md\``
    ),
    '   只为本次写进 targets 的 CLI 准备开发文档：没写进 targets 的 CLI 本次不会启动，不要为它建文档，也不要在回复里提到它。',
    '   一份文档只讲一个模块，模块之间不得改动同一批文件。',
    '   每份开发文档都要写明：目标、验收标准、允许改动的路径（范围内）、明确禁止改动的路径与目录（范围外，任何越界改动都算该任务失败）、相关文件、实施步骤、验证命令。',
    ...(list.length === 1
      ? ['   本次只有一个代码编写 CLI：只出一份开发文档并覆盖全部范围，不要拆分，总览与开发文档可以合并成一份。']
      : ['   本次只写进一个 CLI 时，同样只出一份开发文档并覆盖全部范围，不要拆分。']),
    '   被调起的 CLI 只看得到总览和它自己那份开发文档，看不到别的 CLI 的任务——范围外的事写进「禁止改动」即可，不要指望它自行克制。'
  ]
}

function triggerBlock(kind: SkillKey, ctx: SkillCtx): string {
  const list = ctx.assignments[kind]
  const what = WHAT[kind]
  return [
    '# clichilds 固定执行流程',
    '',
    `## 本次会被拉起的${what} CLI（共 ${list.length} 个，profileId 必须原样使用）`,
    ...list.map((item, i) => `${i + 1}. ${item.label} → profileId=${item.id}`),
    '',
    ...docSteps(kind, list),
    `2. 用文件写入工具创建 \`.clichilds/trigger-${kind}.json\`，不要用 shell 字符串手工拼接 JSON。Windows 路径在 JSON 里优先用正斜杠。内容必须是：`,
    '',
    '```json',
    JSON.stringify(
      {
        query: '<用户完整指令>',
        workDir: '<当前工作目录绝对路径>',
        session: '<系统提示里「本会话 id」给出的那串，原样照抄；系统提示没有这段信息就删掉本行>',
        documentPath: `<${MASTER_DOC[kind]} 的绝对路径>`,
        targets: [
          {
            profileId: '<清单里的 profileId>',
            documents: ['<只交给该 CLI 的文档绝对路径，没有专属文档就省略整个字段>'],
            task: `<${TASK_HINT[kind]}>`
          }
        ]
      },
      null,
      2
    ),
    '```',
    '',
    `   \`session\` 必须是系统提示里给出的本会话 id，原样照抄一个字都不要改（发布输出用的是同一串）；系统提示没有这段信息时删掉整个字段，应用会回退到该工作目录最近启动的主会话。填错或会话已经结束会被整批拒绝，并按错误提示修正。`,
    `   targets 里想拉起哪几个 CLI 就写哪几条：可以是上面清单的任意非空子集，只拉起其中一个也允许（例如用户说「只让某个 CLI 看一下」）。profileId 必须原样取自清单；写错、重复、条目缺 profileId 或 task 会被整批拒绝并把原因告诉你。不写 targets 字段时按清单全员拉起。`,
    `   调起哪些终端由应用固定，你改不了；你能决定的是拉起清单里的哪几个、每个终端收到什么任务、看哪几份文档、产出什么。`,
    `3. 请求本机 bridge：`,
    '',
    '```powershell',
    `curl.exe -sS -X POST ${ctx.bridgeUrl}/trigger/${kind} -H "Content-Type: application/json" --data-binary "@.clichilds/trigger-${kind}.json"`,
    '```',
    '',
    `4. 响应里的 \`runId\` 是本次下发的编号，后面的等待、重试都要用它；\`tasks\` 是每个子任务的状态（\`profileId\`、\`state\`、\`resultFile\`、\`retries\`、\`canRetry\`、\`error\`）。响应只说明终端已经拉起来了，任务还没做完 —— 接下来必须由你盯着，直到每个子任务都产出结果文件或判定失败，期间不要结束本轮回复，也不要只把终端数报给用户就停下。`,
    '',
    `5. 循环观察。每次调用最多阻塞 30 秒；任一子任务从运行中变成完成或失败会立刻返回，所以不要用 sleep 自己轮询：`,
    '',
    '```powershell',
    `curl.exe -sS ${ctx.bridgeUrl}/wait/<runId>`,
    '```',
    '',
    `   只按响应里的 \`nextAction\` 决定下一步，不要自己发明判断：`,
    `   - \`wait\`：还有子任务在跑，再调一次 \`/wait\`，直到它返回别的值。`,
    `   - \`retry\`：有子任务失败了，\`error\` 里写明原因（拉起失败 / 任务没投递进输入框 / 进程提前退出 / 超过设定时间没出结果）。调用 \`/retry\` 让应用按完全相同的任务参数重开这些终端，再回到 \`/wait\` 继续等。同一个子任务最多重试 ${MAX_CHILD_RETRIES} 次，超过上限的请求会被应用拒绝：`,
    '',
    '```powershell',
    `curl.exe -sS ${ctx.bridgeUrl}/retry/<runId>`,
    '```',
    '',
    `   - \`analyze\`：全部子任务都已产出结果文件。逐个读取 \`tasks\` 里每个 \`resultFile\` 的正文，把各 CLI 的结论汇总、对照、去重后给出本次结论（有分歧要写明分歧点与证据），再按「输出展示协议」用 \`/present\` 把要展示的文档发到输出区，最后向用户汇报结论与各结果文件路径。到这一步才可以结束回复。`,
    `   - \`report-failure\`：有子任务失败且重试次数已经用尽。向用户说明是哪个 CLI、什么原因、缺了哪一块结论，然后停止；不要自己拉起终端，也不要伪造、代写或修改结果文件。`,
    `   - \`stop\`：本次下发已经随主会话结束而作废。向用户说明后停止。`,
    '',
    `6. 任何时候拿到 \`ok=false\`（例如应用已重启、这个 runId 已不存在）都立即停止并向用户报告，不要反复调用同一个 runId。中途被用户打断、之后要接着看状态时用：`,
    '',
    '```powershell',
    `curl.exe -sS ${ctx.bridgeUrl}/status/<runId>`,
    '```',
    '',
    `   结果文件都落在 \`${RESULT_DIR}\`；重试会生成新的结果文件，旧的一次次保留，不要覆盖或删除它们。`
  ].join('\n')
}

export function buildSkillFiles(ctx: SkillCtx): SkillFile[] {
  return ctx.commands.filter((command) => command.enabled).map((command) => {
    const kind = command.builtinKind
    const raw = kind && !command.prompt.trim() ? DEFAULT_PROMPTS[kind] : command.prompt
    const fixed = kind && ctx.assignments[kind].length > 0 ? triggerBlock(kind, ctx) : ''
    return {
      name: command.name,
      description: kind ? DESCRIPTIONS[kind] : `自定义命令：用户执行 /${command.name} 时使用。`,
      body: fixed ? `${render(raw).trimEnd()}\n\n${fixed}` : render(raw).trimEnd()
    }
  })
}
