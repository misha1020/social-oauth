interface DebugInfo {
  code: string;
  deviceId: string;
  codeVerifier: string;
}

let _debugInfo: DebugInfo | null = null;

export function setDebugInfo(info: DebugInfo) {
  _debugInfo = info;
}

export function getDebugInfo(): DebugInfo | null {
  return _debugInfo;
}
