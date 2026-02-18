import { createGenericCrudApi } from './genericCrudApi.js'

export function createContractsApi() {
  return createGenericCrudApi({ basePath: '/api/contracts', collectionName: 'contracts' })
}

