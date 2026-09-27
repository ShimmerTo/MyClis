using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace MyClis.Notes
{
    // 只观察鼠标手势；选区读取始终在另一个短命进程中完成。
    internal static class SelectionHelper
    {
        private const int MaxTextLength = 100 * 1024;
        private const int MaxAncestors = 32;
        private const int MaxRanges = 16;
        private const int MaxRectangles = 256;
        private const double PointTolerance = 8;
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        [MTAThread]
        private static int Main(string[] args)
        {
            bool reading = args.Length > 0 && args[0] == "read";
            try
            {
                EnablePhysicalCoordinates();
                if (reading)
                {
                    // 父进程崩溃后也不能留下卡在 UIA 提供程序中的读取进程。
                    using (Timer deadline = new Timer(delegate { Environment.Exit(2); }, null, 2500, Timeout.Infinite))
                    {
                        string text = ReadSelection(args);
                        WriteJson(new { text = text });
                        return 0;
                    }
                }

                int parentPid;
                if (args.Length != 2 || args[0] != "watch" ||
                    !int.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out parentPid) ||
                    parentPid <= 0 || (uint)parentPid == Native.GetCurrentProcessId())
                {
                    return Fail("E_ARGUMENTS");
                }

                using (Watcher watcher = new Watcher(parentPid))
                {
                    string failure = watcher.Run();
                    return failure == null ? 0 : Fail(failure);
                }
            }
            catch
            {
                // 不把系统异常、窗口标题或选区正文带到诊断通道。
                return Fail(reading ? "E_READ_OUTPUT" : "E_WATCH");
            }
        }

        private static int Fail(string code)
        {
            try { Console.Error.WriteLine(code); }
            catch { /* stderr 已关闭时只能依赖退出码。 */ }
            return 1;
        }

        private static void EnablePhysicalCoordinates()
        {
            // UIA 和低级鼠标钩子都使用物理屏幕坐标；混合 DPI 首选每显示器感知。
            try
            {
                if (Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
            }
            catch (EntryPointNotFoundException) { }
            try
            {
                if (Native.SetProcessDpiAwareness(2) == 0) return;
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
            Native.SetProcessDPIAware();
        }

        private static void WriteJson(object message)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = MaxTextLength * 6 + 1024;
            byte[] bytes = Utf8.GetBytes(serializer.Serialize(message) + "\n");
            IntPtr output = Native.GetStdHandle(Native.StdOutput);
            int offset = 0;
            // 使用同步原生写入，关闭时可由主线程 CancelSynchronousIo 解除管道背压。
            GCHandle pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                while (offset < bytes.Length)
                {
                    uint written;
                    if (!Native.WriteFile(output, IntPtr.Add(pin.AddrOfPinnedObject(), offset),
                        (uint)(bytes.Length - offset), out written, IntPtr.Zero) || written == 0)
                    {
                        throw new InvalidOperationException("E_STDOUT");
                    }
                    offset += (int)written;
                }
            }
            finally { pin.Free(); }
        }

        private static IntPtr RootAt(Native.Point point)
        {
            return Native.GetAncestor(Native.WindowFromPoint(point), Native.GaRoot);
        }

        private static uint WindowProcess(IntPtr window)
        {
            uint processId;
            return Native.GetWindowThreadProcessId(window, out processId) == 0 ? 0 : processId;
        }

        private static string WindowString(IntPtr window)
        {
            return window.ToInt64().ToString(CultureInfo.InvariantCulture);
        }

        private static bool IsSourceCurrent(IntPtr window, int processId)
        {
            return window != IntPtr.Zero && Native.IsWindow(window) &&
                Native.GetForegroundWindow() == window && WindowProcess(window) == (uint)processId;
        }

        private enum ProbeResult { Empty, Selected, Refused }

        private static string ReadSelection(string[] args)
        {
            long handle;
            int processId, x, y, startX, startY;
            if (args.Length != 7 ||
                !long.TryParse(args[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out handle) ||
                !int.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out processId) ||
                !int.TryParse(args[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out x) ||
                !int.TryParse(args[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out y) ||
                !int.TryParse(args[5], NumberStyles.Integer, CultureInfo.InvariantCulture, out startX) ||
                !int.TryParse(args[6], NumberStyles.Integer, CultureInfo.InvariantCulture, out startY) ||
                handle == 0 || processId <= 0)
            {
                return "";
            }

            IntPtr window = new IntPtr(handle);
            try
            {
                if (!IsSourceCurrent(window, processId)) return "";
                AutomationElement pointed;
                try { pointed = AutomationElement.FromPoint(new System.Windows.Point(x, y)); }
                catch (ElementNotAvailableException) { pointed = null; }
                string text;
                ProbeResult result = ProbeElement(pointed, window, processId, x, y, startX, startY, out text);
                if (result == ProbeResult.Refused) return "";
                if (result == ProbeResult.Empty)
                {
                    if (!IsSourceCurrent(window, processId)) return "";
                    result = ProbeElement(AutomationElement.FocusedElement, window, processId, x, y, startX, startY, out text);
                }
                return result == ProbeResult.Selected && IsSourceCurrent(window, processId) ? text : "";
            }
            catch
            {
                // 不支持 UIA、权限不足、元素消失或提供程序异常，一律返回空选区。
                return "";
            }
        }

        private static ProbeResult ProbeElement(AutomationElement element, IntPtr window,
            int processId, int x, int y, int startX, int startY, out string text)
        {
            text = "";
            List<AutomationElement> ancestors = new List<AutomationElement>(MaxAncestors);
            bool reachedWindow = false;
            // 先完整检查有界祖先链，再接触 TextPattern，避免读到密码祖先下的文字。
            for (int depth = 0; element != null && depth < MaxAncestors; depth++)
            {
                AutomationElement.AutomationElementInformation current = element.Current;
                if (current.ProcessId != processId)
                {
                    return ancestors.Count == 0 ? ProbeResult.Empty : ProbeResult.Refused;
                }
                if (current.IsPassword) return ProbeResult.Refused;
                ancestors.Add(element);
                // UIA 用有符号 32 位整数表示 HWND，Win32 在 x64 上传递零扩展句柄。
                if (new IntPtr(unchecked((long)(uint)current.NativeWindowHandle)) == window)
                {
                    reachedWindow = true;
                    break;
                }
                element = TreeWalker.RawViewWalker.GetParent(element);
            }
            // 祖先链过深或中断时拒绝回退，不能绕过尚未完成的密码检查。
            if (!reachedWindow) return ancestors.Count == 0 ? ProbeResult.Empty : ProbeResult.Refused;

            foreach (AutomationElement candidate in ancestors)
            {
                object value;
                if (!candidate.TryGetCurrentPattern(TextPattern.Pattern, out value)) continue;
                ProbeResult result = ReadPattern((TextPattern)value, x, y, startX, startY, out text);
                if (result == ProbeResult.Selected)
                {
                    foreach (AutomationElement ancestor in ancestors)
                    {
                        if (ancestor.Current.ProcessId != processId || ancestor.Current.IsPassword)
                        {
                            text = "";
                            return ProbeResult.Refused;
                        }
                    }
                }
                if (result != ProbeResult.Empty) return result;
            }
            return ProbeResult.Empty;
        }

        private static ProbeResult ReadPattern(TextPattern pattern, int x, int y, int startX, int startY, out string text)
        {
            text = "";
            TextPatternRange[] ranges = pattern.GetSelection();
            if (ranges == null || ranges.Length == 0) return ProbeResult.Empty;
            if (ranges.Length > MaxRanges) return ProbeResult.Refused;
            bool nearby = false;
            int rectangleCount = 0;
            foreach (TextPatternRange range in ranges)
            {
                if (range == null) return ProbeResult.Refused;
                System.Windows.Rect[] rectangles = range.GetBoundingRectangles();
                if (rectangles == null) return ProbeResult.Refused;
                rectangleCount += rectangles.Length;
                if (rectangleCount > MaxRectangles) return ProbeResult.Refused;
                foreach (System.Windows.Rect rectangle in rectangles)
                {
                    double left = rectangle.X;
                    double top = rectangle.Y;
                    double width = rectangle.Width;
                    double height = rectangle.Height;
                    double right = left + width;
                    double bottom = top + height;
                    if (!Finite(left) || !Finite(top) || !Finite(width) || !Finite(height) ||
                        !Finite(right) || !Finite(bottom) || width < 0 || height < 0)
                    {
                        return ProbeResult.Refused;
                    }
                    if (width > 0 && height > 0 &&
                        IntersectsSelection(startX, startY, x, y, left - PointTolerance,
                            top - PointTolerance, right + PointTolerance, bottom + PointTolerance))
                    {
                        nearby = true;
                    }
                }
            }
            // 只检查当前选择的矩形，绝不读取整段文本来定位选择。
            if (!nearby) return ProbeResult.Empty;

            StringBuilder selected = new StringBuilder();
            foreach (TextPatternRange range in ranges)
            {
                int remaining = MaxTextLength - selected.Length;
                // 多读一个字符用于识别被截断的超大选区，不把截断内容当完整结果。
                string part = range.GetText(remaining + 1);
                if (part == null || part.Length > remaining) return ProbeResult.Refused;
                if (part.Length == 0) continue;
                if (selected.Length > 0)
                {
                    if (part.Length + 1 > remaining) return ProbeResult.Refused;
                    selected.Append('\n');
                }
                selected.Append(part);
            }
            text = selected.ToString();
            if (string.IsNullOrWhiteSpace(text))
            {
                text = "";
                return ProbeResult.Empty;
            }
            return ProbeResult.Selected;
        }

        private static bool IntersectsSelection(double startX, double startY, double endX, double endY,
            double left, double top, double right, double bottom)
        {
            double first = 0, last = 1;
            double dx = endX - startX, dy = endY - startY;
            return Clip(-dx, startX - left, ref first, ref last) &&
                Clip(dx, right - startX, ref first, ref last) &&
                Clip(-dy, startY - top, ref first, ref last) &&
                Clip(dy, bottom - startY, ref first, ref last);
        }

        private static bool Clip(double direction, double distance, ref double first, ref double last)
        {
            if (direction == 0) return distance >= 0;
            double position = distance / direction;
            if (direction < 0)
            {
                if (position > last) return false;
                first = Math.Max(first, position);
            }
            else
            {
                if (position < first) return false;
                last = Math.Min(last, position);
            }
            return true;
        }

        private static bool Finite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        private sealed class Watcher : IDisposable
        {
            private readonly int parentPid;
            private readonly BlockingCollection<object> events = new BlockingCollection<object>(64);
            private readonly ManualResetEvent stopping = new ManualResetEvent(false);
            private readonly ManualResetEvent writerReady = new ManualResetEvent(false);
            private readonly Native.MouseProc mouseCallback;
            private readonly Native.WinEventProc foregroundCallback;
            private Process parent;
            private Thread writer;
            private Thread lifetime;
            private IntPtr writerHandle;
            private IntPtr mouseHook;
            private IntPtr foregroundHook;
            private string failure;
            private bool leftDown;
            private bool secondClick;
            private bool previousClick;
            private Native.Point downPoint;
            private Native.Point previousPoint;
            private uint downTime;
            private uint previousTime;
            private uint downProcess;
            private IntPtr downWindow;
            private IntPtr previousWindow;
            private bool disposed;

            internal Watcher(int pid)
            {
                parentPid = pid;
                // 委托随 watcher 保活，直到两个原生钩子都解除。
                mouseCallback = OnMouse;
                foregroundCallback = OnForeground;
            }

            internal string Run()
            {
                try
                {
                    parent = Process.GetProcessById(parentPid);
                    if (parent.HasExited) return "E_PARENT";
                    IntPtr input = Native.GetStdHandle(Native.StdInput);
                    if (Native.GetFileType(input) != Native.FileTypePipe) return "E_STDIN";

                    writer = new Thread(OutputLoop);
                    writer.IsBackground = true;
                    writer.Name = "notes-selection-output";
                    writer.Start();
                    writerReady.WaitOne();
                    if (stopping.WaitOne(0)) return failure;

                    mouseHook = Native.SetWindowsHookEx(Native.WhMouseLl, mouseCallback,
                        Native.GetModuleHandle(null), 0);
                    if (mouseHook == IntPtr.Zero) return "E_MOUSE_HOOK";
                    foregroundHook = Native.SetWinEventHook(Native.EventSystemForeground,
                        Native.EventSystemForeground, IntPtr.Zero, foregroundCallback, 0, 0, 0);
                    if (foregroundHook == IntPtr.Zero) return "E_FOREGROUND_HOOK";

                    lifetime = new Thread(delegate() { LifetimeLoop(input); });
                    lifetime.IsBackground = true;
                    lifetime.Name = "notes-selection-lifetime";
                    lifetime.Start();
                    Enqueue(new { type = "ready" });
                    PumpMessages();
                }
                catch { Stop("E_WATCH"); }
                finally { Shutdown(); }
                return failure;
            }

            private void Stop(string code)
            {
                if (code != null) Interlocked.CompareExchange(ref failure, code, null);
                stopping.Set();
            }

            private void Enqueue(object message)
            {
                if (stopping.WaitOne(0)) return;
                // 队列满时停止而不是丢弃 dismiss，避免 Electron 留下过期浮窗。
                if (!events.TryAdd(message)) Stop("E_EVENT_OVERFLOW");
            }

            private void OutputLoop()
            {
                try
                {
                    writerHandle = Native.OpenThread(Native.ThreadTerminate, false, Native.GetCurrentThreadId());
                    if (writerHandle == IntPtr.Zero)
                    {
                        Stop("E_OUTPUT_THREAD");
                        return;
                    }
                    writerReady.Set();
                    foreach (object message in events.GetConsumingEnumerable())
                    {
                        if (stopping.WaitOne(0)) break;
                        WriteJson(message);
                    }
                }
                catch
                {
                    if (!stopping.WaitOne(0)) Stop("E_STDOUT");
                }
                finally { writerReady.Set(); }
            }

            private void LifetimeLoop(IntPtr input)
            {
                byte[] discard = new byte[256];
                try
                {
                    while (!stopping.WaitOne(100))
                    {
                        if (parent.HasExited)
                        {
                            Stop(null);
                            return;
                        }
                        uint available;
                        if (!Native.PeekNamedPipe(input, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero))
                        {
                            int error = Marshal.GetLastWin32Error();
                            Stop(error == Native.ErrorBrokenPipe || error == Native.ErrorPipeNotConnected
                                ? null : "E_STDIN");
                            return;
                        }
                        // 只消费已就绪字节，不保留内容，不阻塞等待输入。
                        if (available > 0)
                        {
                            uint read;
                            if (!Native.ReadFile(input, discard, Math.Min(available, (uint)discard.Length),
                                out read, IntPtr.Zero))
                            {
                                int error = Marshal.GetLastWin32Error();
                                Stop(error == Native.ErrorBrokenPipe || error == Native.ErrorPipeNotConnected
                                    ? null : "E_STDIN");
                                return;
                            }
                            if (read == 0)
                            {
                                Stop(null);
                                return;
                            }
                        }
                    }
                }
                catch { Stop("E_PARENT"); }
            }

            private void PumpMessages()
            {
                IntPtr[] handles = { stopping.SafeWaitHandle.DangerousGetHandle() };
                while (!stopping.WaitOne(0))
                {
                    // 与停止事件一起等待消息，关闭无需向可能满载的消息队列投递 WM_QUIT。
                    uint result = Native.MsgWaitForMultipleObjects(1, handles, false,
                        Native.Infinite, Native.QsAllInput);
                    if (result == 0) break;
                    if (result != 1)
                    {
                        Stop("E_MESSAGE_PUMP");
                        break;
                    }
                    Native.Message message;
                    while (!stopping.WaitOne(0) && Native.PeekMessage(out message, IntPtr.Zero, 0, 0, 1))
                    {
                        if (message.Id == Native.WmQuit)
                        {
                            Stop(null);
                            break;
                        }
                        Native.TranslateMessage(ref message);
                        Native.DispatchMessage(ref message);
                    }
                }
            }

            private IntPtr OnMouse(int code, IntPtr message, IntPtr data)
            {
                try
                {
                    uint kind = unchecked((uint)message.ToInt64());
                    // 不解析、不排队鼠标移动事件流。
                    bool down = kind == Native.WmLButtonDown || kind == Native.WmRButtonDown ||
                        kind == Native.WmMButtonDown || kind == Native.WmXButtonDown;
                    bool wheel = kind == Native.WmMouseWheel || kind == Native.WmMouseHWheel;
                    if (code >= 0 && (down || wheel || kind == Native.WmLButtonUp) && !stopping.WaitOne(0))
                    {
                        Native.MouseData mouse = (Native.MouseData)Marshal.PtrToStructure(data, typeof(Native.MouseData));
                        IntPtr root = RootAt(mouse.Position);
                        if (down || wheel)
                        {
                            Enqueue(new { type = "dismiss", window = WindowString(root) });
                            if (kind == Native.WmLButtonDown) BeginClick(mouse, root);
                            else ResetGesture();
                        }
                        else EndClick(mouse, root);
                    }
                }
                catch { Stop("E_MOUSE_EVENT"); }
                return Native.CallNextHookEx(mouseHook, code, message, data);
            }

            private void BeginClick(Native.MouseData mouse, IntPtr root)
            {
                secondClick = previousClick && previousWindow == root &&
                    unchecked(mouse.Time - previousTime) <= Native.GetDoubleClickTime() &&
                    InDoubleClickRectangle(mouse.Position);
                previousClick = false;
                leftDown = true;
                downPoint = mouse.Position;
                downTime = mouse.Time;
                downWindow = root;
                downProcess = WindowProcess(root);
            }

            private bool InDoubleClickRectangle(Native.Point point)
            {
                int width = Native.GetSystemMetrics(Native.SmCxDoubleClick);
                int height = Native.GetSystemMetrics(Native.SmCyDoubleClick);
                long left = (long)previousPoint.X - width / 2;
                long top = (long)previousPoint.Y - height / 2;
                // 与原生 RECT 一致：左/上包含，右/下不包含。
                return point.X >= left && point.X < left + width &&
                    point.Y >= top && point.Y < top + height;
            }

            private void EndClick(Native.MouseData mouse, IntPtr root)
            {
                if (!leftDown) return;
                leftDown = false;
                bool valid = downWindow != IntPtr.Zero && root == downWindow &&
                    root == Native.GetForegroundWindow() && downProcess != 0 &&
                    downProcess != (uint)parentPid && WindowProcess(root) == downProcess;
                if (!valid)
                {
                    ResetGesture();
                    return;
                }
                long dx = (long)mouse.Position.X - downPoint.X;
                long dy = (long)mouse.Position.Y - downPoint.Y;
                // 使用 double 避免极端屏幕坐标差的平方溢出。
                bool dragged = (double)dx * dx + (double)dy * dy >= 16;
                if (dragged || secondClick)
                {
                    Enqueue(new { type = "selection", window = WindowString(root), processId = downProcess,
                        x = mouse.Position.X, y = mouse.Position.Y, startX = downPoint.X, startY = downPoint.Y });
                    previousClick = false;
                }
                else
                {
                    previousClick = true;
                    previousPoint = downPoint;
                    previousTime = downTime;
                    previousWindow = root;
                }
                secondClick = false;
            }

            private void OnForeground(IntPtr hook, uint eventType, IntPtr window,
                int objectId, int childId, uint eventThread, uint eventTime)
            {
                try
                {
                    if (eventType != Native.EventSystemForeground || stopping.WaitOne(0)) return;
                    previousClick = false;
                    secondClick = false;
                    Enqueue(new { type = "dismiss", window = WindowString(window) });
                }
                catch { Stop("E_FOREGROUND_EVENT"); }
            }

            private void ResetGesture()
            {
                leftDown = false;
                secondClick = false;
                previousClick = false;
            }

            private void Shutdown()
            {
                Stop(null);
                if (mouseHook != IntPtr.Zero)
                {
                    if (!Native.UnhookWindowsHookEx(mouseHook)) Stop("E_MOUSE_UNHOOK");
                    mouseHook = IntPtr.Zero;
                }
                if (foregroundHook != IntPtr.Zero)
                {
                    if (!Native.UnhookWinEvent(foregroundHook)) Stop("E_FOREGROUND_UNHOOK");
                    foregroundHook = IntPtr.Zero;
                }
                events.CompleteAdding();
                if (lifetime != null && lifetime.IsAlive && !lifetime.Join(1000)) Stop("E_LIFETIME_STOP");
                if (writer != null)
                {
                    bool finished = !writer.IsAlive || writer.Join(100);
                    for (int attempt = 0; !finished && attempt < 3; attempt++)
                    {
                        // ERROR_NOT_FOUND 表示取消时恰好没有同步 I/O，下一次有界重试即可。
                        if (writerHandle != IntPtr.Zero) Native.CancelSynchronousIo(writerHandle);
                        finished = writer.Join(100);
                    }
                    if (!finished) Stop("E_OUTPUT_STOP");
                }
                GC.KeepAlive(mouseCallback);
                GC.KeepAlive(foregroundCallback);
            }

            // 主线程退出时后台线程也随进程结束；仍活跃的等待对象不能提前 Dispose。
            public void Dispose()
            {
                if (disposed) return;
                disposed = true;
                if (writerHandle != IntPtr.Zero) Native.CloseHandle(writerHandle);
                if (parent != null && (lifetime == null || !lifetime.IsAlive)) parent.Dispose();
                if ((writer == null || !writer.IsAlive) && (lifetime == null || !lifetime.IsAlive))
                {
                    events.Dispose();
                    stopping.Dispose();
                    writerReady.Dispose();
                }
            }
        }

        private static class Native
        {
            internal const int WhMouseLl = 14;
            internal const uint GaRoot = 2;
            internal const uint EventSystemForeground = 3;
            internal const uint WmQuit = 0x0012;
            internal const uint WmLButtonDown = 0x0201;
            internal const uint WmLButtonUp = 0x0202;
            internal const uint WmRButtonDown = 0x0204;
            internal const uint WmMButtonDown = 0x0207;
            internal const uint WmMouseWheel = 0x020A;
            internal const uint WmXButtonDown = 0x020B;
            internal const uint WmMouseHWheel = 0x020E;
            internal const uint QsAllInput = 0x04FF;
            internal const uint Infinite = 0xFFFFFFFF;
            internal const uint ThreadTerminate = 1;
            internal const uint FileTypePipe = 3;
            internal const int StdInput = -10;
            internal const int StdOutput = -11;
            internal const int SmCxDoubleClick = 36;
            internal const int SmCyDoubleClick = 37;
            internal const int ErrorBrokenPipe = 109;
            internal const int ErrorPipeNotConnected = 233;

            [StructLayout(LayoutKind.Sequential)]
            internal struct Point { internal int X; internal int Y; }
            [StructLayout(LayoutKind.Sequential)]
            internal struct MouseData
            {
                internal Point Position;
                internal uint Data;
                internal uint Flags;
                internal uint Time;
                internal UIntPtr ExtraInfo;
            }
            [StructLayout(LayoutKind.Sequential)]
            internal struct Message
            {
                internal IntPtr Window;
                internal uint Id;
                internal UIntPtr WParam;
                internal IntPtr LParam;
                internal uint Time;
                internal Point Position;
                internal uint Private;
            }
            internal delegate IntPtr MouseProc(int code, IntPtr message, IntPtr data);
            internal delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr window,
                int objectId, int childId, uint eventThread, uint eventTime);

            [DllImport("user32.dll", SetLastError = true)]
            internal static extern IntPtr SetWindowsHookEx(int id, MouseProc callback, IntPtr module, uint threadId);
            [DllImport("user32.dll")]
            internal static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
            [DllImport("user32.dll")]
            internal static extern bool UnhookWindowsHookEx(IntPtr hook);
            [DllImport("user32.dll")]
            internal static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module,
                WinEventProc callback, uint processId, uint threadId, uint flags);
            [DllImport("user32.dll")]
            internal static extern bool UnhookWinEvent(IntPtr hook);
            [DllImport("user32.dll")]
            internal static extern IntPtr WindowFromPoint(Point point);
            [DllImport("user32.dll")]
            internal static extern IntPtr GetAncestor(IntPtr window, uint flags);
            [DllImport("user32.dll")]
            internal static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")]
            internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
            [DllImport("user32.dll")]
            internal static extern bool IsWindow(IntPtr window);
            [DllImport("user32.dll")]
            internal static extern uint GetDoubleClickTime();
            [DllImport("user32.dll")]
            internal static extern int GetSystemMetrics(int index);
            [DllImport("user32.dll")]
            internal static extern uint MsgWaitForMultipleObjects(uint count, IntPtr[] handles,
                bool waitAll, uint timeout, uint wakeMask);
            [DllImport("user32.dll")]
            internal static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
            [DllImport("user32.dll")]
            internal static extern bool TranslateMessage(ref Message message);
            [DllImport("user32.dll")]
            internal static extern IntPtr DispatchMessage(ref Message message);
            [DllImport("user32.dll")]
            internal static extern bool SetProcessDpiAwarenessContext(IntPtr context);
            [DllImport("shcore.dll")]
            internal static extern int SetProcessDpiAwareness(int awareness);
            [DllImport("user32.dll")]
            internal static extern bool SetProcessDPIAware();
            [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
            internal static extern IntPtr GetModuleHandle(string name);
            [DllImport("kernel32.dll")]
            internal static extern IntPtr GetStdHandle(int id);
            [DllImport("kernel32.dll")]
            internal static extern uint GetFileType(IntPtr file);
            [DllImport("kernel32.dll")]
            internal static extern uint GetCurrentThreadId();
            [DllImport("kernel32.dll")]
            internal static extern uint GetCurrentProcessId();
            [DllImport("kernel32.dll")]
            internal static extern IntPtr OpenThread(uint access, bool inherit, uint threadId);
            [DllImport("kernel32.dll")]
            internal static extern bool CloseHandle(IntPtr handle);
            [DllImport("kernel32.dll")]
            internal static extern bool CancelSynchronousIo(IntPtr thread);
            [DllImport("kernel32.dll", SetLastError = true)]
            internal static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint bufferSize,
                IntPtr bytesRead, out uint available, IntPtr bytesLeft);
            [DllImport("kernel32.dll", SetLastError = true)]
            internal static extern bool ReadFile(IntPtr file, byte[] buffer, uint count, out uint read, IntPtr overlapped);
            [DllImport("kernel32.dll", SetLastError = true)]
            internal static extern bool WriteFile(IntPtr file, IntPtr buffer, uint count, out uint written, IntPtr overlapped);
        }
    }
}
