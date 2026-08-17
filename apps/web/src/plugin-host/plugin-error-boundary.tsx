import { Component, type ReactNode } from 'react';

interface Props {
  pluginId: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class PluginErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error(`[plugin-host] plugin "${this.props.pluginId}" threw:`, error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: '0.75rem',
            border: '1px dashed crimson',
            borderRadius: '0.5rem',
            fontSize: '0.875rem',
            color: 'crimson',
          }}
        >
          Plugin <code>{this.props.pluginId}</code> failed to render: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}
