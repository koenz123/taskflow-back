import mongoose from 'mongoose'

let connectPromise = null

export function isMongoEnabled() {
  return Boolean(process.env.MONGODB_URI)
}

export async function connectMongo(uri = process.env.MONGODB_URI) {
  if (!uri) return { enabled: false }

  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  if (mongoose.connection.readyState === 1) return { enabled: true }

  if (!connectPromise) {
    connectPromise = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 5000,
      })
      .then(() => ({ enabled: true }))
      .catch((e) => {
        // Allow app to run even if Mongo is down.
        connectPromise = null
        console.error('[mongo] connect failed', e?.message || e)
        return { enabled: false, error: e }
      })
  }

  return await connectPromise
}

