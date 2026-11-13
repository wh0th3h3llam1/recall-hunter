import { Component, type ReactNode } from 'react';

/** Catches WebGL/three errors (e.g. "Error creating WebGL context") so the rest of the app keeps running. */
export default class GLBoundary extends Component<{ fallback: ReactNode; onError?: (e: Error) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: Error) {
    console.warn('[recall-hunter] 3D disabled:', e?.message);
    this.props.onError?.(e);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
