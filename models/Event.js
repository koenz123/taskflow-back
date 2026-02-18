import mongoose from 'mongoose'

const { Schema } = mongoose

const EventSchema = new Schema(
  {
    // New analytics-friendly fields (preferred)
    actor: { type: String, default: null, index: true },
    target: { type: String, default: null, index: true },
    ts: { type: Date, default: () => new Date(), index: true },

    // Backward-compatible aliases (older shape)
    userId: { type: String, default: null, index: true },
    type: { type: String, required: true, index: true },
    entityId: { type: String, default: null, index: true },
    meta: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: () => new Date(), index: true },
  },
  { versionKey: false, strict: true },
)

// Helpful compound index for querying user timelines.
EventSchema.index({ userId: 1, createdAt: -1 })
EventSchema.index({ actor: 1, ts: -1 })
EventSchema.index({ type: 1, actor: 1, ts: -1 })
EventSchema.index({ type: 1, ts: -1 })

export const Event = mongoose.models.Event || mongoose.model('Event', EventSchema)

