import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './theme/theme.css'

/**
 * 全局拖放兜底：没有任何接收方时，Chromium 的默认行为是把整个渲染层替换成被拖入的文件
 * —— 界面消失，且本应用没有地址栏与菜单，用户只能靠 F12/F5 或重启救回来。
 * 便签功能正在鼓励用户拖文件，手一抖落在终端区就会踩到，所以这里统一拦掉默认行为；
 * 真正要接收拖放的区域自己再 preventDefault 并在 drop 里处理。
 */
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
