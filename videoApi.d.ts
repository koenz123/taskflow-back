export type CreateVideoApiOptions = {
  worksFile: string
  uploadsDir: string
  maxFileBytes: number
}

export function createVideoApi(options: CreateVideoApiOptions): any

