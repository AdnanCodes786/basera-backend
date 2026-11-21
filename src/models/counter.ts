import { Schema, model } from 'mongoose';

/** Per-society running numbers: complaint #1, #2…, receipt numbers. _id like "<societyId>:complaint". */
const counterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export const CounterModel = model('Counter', counterSchema);

export async function nextSeq(key: string): Promise<number> {
  const doc = await CounterModel.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  return doc!.seq;
}
