export interface CaptureRequest {
  url: string;
  duration: number;
  width: number;
  height: number;
}

export interface CaptureResult {
  jobId: string;
  filename: string;
  downloadUrl: string;
}

export interface Recording {
  filename: string;
  downloadUrl: string;
  createdAt: string;
}

export type CaptureStatus = 'idle' | 'capturing' | 'done' | 'error';
