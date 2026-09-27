import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** 出错区块的名字，直接出现在错误卡片标题里 */
  label: string
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 局部崩溃兜底。
 *
 * 渲染层任何一处抛异常，React 会把整棵组件树卸载，用户看到的就是纯白窗口；
 * 套上它之后只有出错的那一块变成错误卡片，导航栏和其它面板继续可用，
 * 并且把异常文本留在界面上，不用连开发者工具也能报修。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 渲染层没有主进程日志通道，完整堆栈打到控制台供 CDP / 开发者工具排查。
    console.error(`[${this.props.label}] 渲染出错`, error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const stack = (error.stack ?? '').split('\n').slice(1, 7).join('\n')
    return (
      <div className="crash-card" role="alert">
        <h2>{this.props.label}出错了</h2>
        <p className="crash-msg">{error.message || '未提供错误信息'}</p>
        {stack && <pre className="crash-stack">{stack}</pre>}
        <div className="crash-actions">
          <button type="button" onClick={() => this.setState({ error: null })}>重试这一块</button>
          <button type="button" onClick={() => window.location.reload()}>重新加载应用</button>
        </div>
      </div>
    )
  }
}
