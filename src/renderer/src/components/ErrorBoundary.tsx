import { Component, type ErrorInfo, type ReactNode } from 'react'
import { getActiveUiText } from '../i18n'
import { RecoveryState } from './RecoveryState'
import { ViewRecoveryContext } from '../utils/lazyWithRetry'

type ErrorBoundaryProps = {
  children: ReactNode
  resetKey?: string
  onNavigate?: () => void
  navigateLabel?: string
  page?: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null; resetKey?: string; attempt: object }> {
  state = { error: null as Error | null, resetKey: this.props.resetKey, attempt: {} }
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) } }
  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: { resetKey?: string; error: Error | null }) {
    return props.resetKey !== state.resetKey ? { resetKey: props.resetKey, ...(state.error ? { error: null, attempt: {} } : {}) } : null
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('KnowBook view failed.', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return <ViewRecoveryContext.Provider value={this.state.attempt}>{this.props.children}</ViewRecoveryContext.Provider>
    const isZh = getActiveUiText().language === 'zh-CN'
    return <RecoveryState title={isZh ? '页面出现异常' : 'Something went wrong on this page'}
      description={this.props.page
        ? (isZh ? '可以重试当前页面，或切换到其他页面。重试不会主动清除编辑草稿。' : 'Retry this view or switch pages. Retrying does not clear editor drafts.')
        : (isZh ? '界面暂时无法继续显示。可以重试；若问题持续，可重新加载或以安全模式启动。' : 'The interface could not be displayed. Retry, reload, or restart in safe mode if the problem persists.')}
      error={this.state.error} onRetry={() => this.setState({ error: null, attempt: {} })} allowRestart
      onNavigate={this.props.onNavigate} navigateLabel={this.props.navigateLabel} />
  }
}
