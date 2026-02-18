import { createGenericCrudApi } from './genericCrudApi.js'

export function createApplicationsApi() {
  return createGenericCrudApi({ basePath: '/api/applications', collectionName: 'applications' })
}

