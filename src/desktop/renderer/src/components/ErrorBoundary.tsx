import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 自定义降级 UI；默认展示错误详情与重载入口。 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 全局错误边界。
 *
 * Electron 打包后渲染进程走 file:// 协议，没有 dev server 的 overlay，
 * 任一页面抛异常都会导致整应用白屏且无任何线索。此组件保证单页崩溃不会
 * 拖垮全局，并把堆栈暴露给用户以便反馈。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[EAG] 渲染进程未捕获异常:", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="h-full w-full flex items-center justify-center p-8">
        <div className="max-w-xl w-full bg-n-900 border border-red/30 rounded-xl p-6">
          <h2 className="text-base font-semibold text-n-100 mb-2">页面出错了</h2>
          <p className="text-xs text-n-400 mb-4">
            该页面的渲染被中断，其余功能仍可使用。你可以重试或复制下列信息反馈给管理员。
          </p>
          <pre className="text-[11px] font-mono text-red whitespace-pre-wrap break-all max-h-48 overflow-auto bg-n-950 rounded-lg p-3">
            {error.message}
            {"\n\n"}
            {error.stack}
          </pre>
          <button
            onClick={this.reset}
            className="mt-4 px-4 py-2 bg-n-700 hover:bg-n-600 text-n-100 text-xs font-medium rounded-lg transition-colors"
          >
            重试
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
