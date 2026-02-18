import { createGenericCrudApi } from './genericCrudApi.js'

export function createAssignmentsApi() {
  return createGenericCrudApi({ basePath: '/api/assignments', collectionName: 'assignments' })
}

