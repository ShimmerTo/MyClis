import type { CliConfig, CliStatus } from '@shared/types'
import { profileLabels } from '@shared/profile'

interface Props {
  profiles: CliConfig[]
  clis: CliStatus[]
  selectedIds: string[]
  /** true = 多选；false = 单选 */
  multiple?: boolean
  /** 单选时再点一次可取消 */
  allowEmpty?: boolean
  onChange: (ids: string[]) => void
}

/** CLI 档案选择网格：启动页主 CLI 栏与「添加 CLI」弹窗共用 */
export function ProfileChoiceGrid(props: Props): JSX.Element {
  if (props.profiles.length === 0) {
    return <div className="empty">暂无已配置 CLI，请先到设置页添加。</div>
  }
  return (
    <div className="profile-choice-grid">
      {props.profiles.map((profile) => {
        const status = props.clis.find((cli) => cli.id === profile.cli)
        const available = !!status?.installed
        const selected = props.selectedIds.includes(profile.id)
        const { permissionLabel, label } = profileLabels(profile, props.clis)
        return (
          <button
            key={profile.id}
            type="button"
            className={`profile-choice ${selected ? 'on' : ''} ${available ? '' : 'missing'}`}
            disabled={!available && !selected}
            onClick={() => {
              if (props.multiple) {
                props.onChange(
                  selected
                    ? props.selectedIds.filter((id) => id !== profile.id)
                    : [...props.selectedIds, profile.id]
                )
              } else if (selected && props.allowEmpty) {
                props.onChange([])
              } else {
                props.onChange([profile.id])
              }
            }}
          >
            <span className={`choice-check ${selected ? 'on' : ''}`}>{selected ? '✓' : ''}</span>
            <span>
              <b>{label}</b>
              <small>
                {profile.model || '默认模型'} · {permissionLabel}
                {!available ? ' · 未检测到' : ''}
              </small>
            </span>
          </button>
        )
      })}
    </div>
  )
}
