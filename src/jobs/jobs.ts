/**
 * The scheduled jobs. Each takes `now` so tests can run them for any date,
 * and each is safe to run twice (see the comment on each for how).
 */
import { Types } from 'mongoose';
import { logger } from '../config/logger.js';
import { ComplaintModel } from '../models/complaint.js';
import { DueModel } from '../models/due.js';
import { InviteModel } from '../models/invite.js';
import { claimOnce } from '../models/jobLock.js';
import { SocietyModel } from '../models/society.js';
import { ACTIVE_STATUSES } from '../modules/complaints/complaints.routes.js';
import { computeStatement } from '../modules/finance/statement.service.js';
import { generateDues } from '../modules/maintenance/dues.service.js';
import { notify } from '../services/notify.js';
import { adminUserIds, allMemberUserIds, familyMemberUserIds } from '../services/recipients.js';
import { addHours, istDayDiff, istParts, isoWeekKey, periodLabel, periodOf, shiftPeriod } from '../utils/dates.js';
import { formatPaise } from '../utils/money.js';

const MAX_OVERDUE_REMINDERS = 10;

/**
 * Daily 00:15 IST. Creates this month's dues for societies whose plan is active,
 * once today is on/after generateOnDay. Duplicate-safe via the unique (familyId, period) index.
 */
export async function generateDuesJob(now = new Date()) {
  const { day } = istParts(now);
  const period = periodOf(now);
  const societies = await SocietyModel.find({ isActive: true, 'maintenance.isActive': true }, { maintenance: 1 }).lean();
  let created = 0;
  for (const s of societies) {
    const plan = s.maintenance!;
    if (day < (plan.generateOnDay ?? 1)) continue;
    if (plan.startPeriod && period < plan.startPeriod) continue;
    try {
      created += (await generateDues(s._id, period)).created;
    } catch (err) {
      logger.error({ err, societyId: s._id }, 'generateDues failed for society');
    }
  }
  return { societies: societies.length, created };
}

/**
 * Daily 09:00 IST. For each pending/partial due:
 *  - N days before (plan.reminderDaysBefore, default 3 and 1), on the due date,
 *  - then every plan.overdueReminderEveryDays after it (max 10 overdue reminders).
 * lastReminderAt stops a second reminder the same IST day if the job reruns.
 */
export async function sendDueRemindersJob(now = new Date()) {
  const societies = await SocietyModel.find({ isActive: true, 'maintenance.isActive': true }, { maintenance: 1 }).lean();
  const plans = new Map(societies.map((s) => [String(s._id), s.maintenance!]));
  const dues = await DueModel.find({ societyId: { $in: [...plans.keys()] }, status: { $in: ['pending', 'partial'] } });

  let sent = 0;
  for (const due of dues) {
    const plan = plans.get(String(due.societyId))!;
    if (due.lastReminderAt && istDayDiff(due.lastReminderAt, now) === 0) continue;

    const daysToDue = istDayDiff(now, due.dueDate); // >0 before the due date, <0 after
    const balance = due.amount - due.amountPaid;
    const month = periodLabel(due.period);
    let msg: { type: 'due_reminder' | 'due_overdue'; title: string; body: string } | null = null;

    if (daysToDue > 0 && (plan.reminderDaysBefore ?? [3, 1]).includes(daysToDue)) {
      const dateText = due.dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
      msg = { type: 'due_reminder', title: 'Maintenance reminder', body: `Maintenance of ${formatPaise(balance)} for ${month} is due on ${dateText}.` };
    } else if (daysToDue === 0) {
      msg = { type: 'due_reminder', title: 'Maintenance due today', body: `Maintenance of ${formatPaise(balance)} for ${month} is due today.` };
    } else if (daysToDue < 0) {
      const late = -daysToDue;
      const every = plan.overdueReminderEveryDays ?? 3;
      if (late % every === 0 && (due.overdueReminderCount ?? 0) < MAX_OVERDUE_REMINDERS) {
        msg = { type: 'due_overdue', title: 'Maintenance overdue', body: `Maintenance for ${month} is ${late} days overdue (${formatPaise(balance)} pending).` };
      }
    }
    if (!msg) continue;

    await notify({
      userIds: await familyMemberUserIds(due.societyId, due.familyId),
      societyId: due.societyId,
      ...msg,
      data: { dueId: String(due._id) },
    });
    due.reminderCount += 1;
    if (msg.type === 'due_overdue') due.overdueReminderCount = (due.overdueReminderCount ?? 0) + 1;
    due.lastReminderAt = now;
    await due.save();
    sent += 1;
  }
  return { checked: dues.length, sent };
}

/**
 * Hourly. Active complaints past nextUpdateDueAt → alert admins, count the breach.
 * Re-alerts only after another full SLA window without an update (lastBreachNotifiedAt).
 */
export async function complaintSlaJob(now = new Date()) {
  const late = await ComplaintModel.find({ status: { $in: ACTIVE_STATUSES }, nextUpdateDueAt: { $ne: null, $lte: now } });
  const slaBySociety = new Map<string, number>();
  let alerted = 0;

  for (const c of late) {
    const key = String(c.societyId);
    if (!slaBySociety.has(key)) {
      const s = await SocietyModel.findById(c.societyId, { 'settings.complaintSlaHours': 1 }).lean();
      slaBySociety.set(key, s?.settings?.complaintSlaHours ?? 48);
    }
    const sla = slaBySociety.get(key)!;
    if (c.lastBreachNotifiedAt && addHours(c.lastBreachNotifiedAt, sla) > now) continue;

    const since = c.lastAdminUpdateAt ?? c.createdAt;
    const hours = Math.floor((now.getTime() - since.getTime()) / 3_600_000);
    await notify({
      userIds: await adminUserIds(c.societyId),
      societyId: c.societyId,
      type: 'complaint_sla_breach',
      title: `Complaint #${c.number} needs an update`,
      body: `"${c.title}" has had no update for ${hours} hours.`,
      data: { complaintId: String(c._id) },
    });
    c.slaBreachCount += 1;
    c.lastBreachNotifiedAt = now;
    await c.save();
    alerted += 1;
  }
  return { late: late.length, alerted };
}

/** 2nd of the month, 10:00 IST. Once per society per month (job lock). */
export async function statementReadyJob(now = new Date()) {
  const period = shiftPeriod(periodOf(now), -1);
  const societies = await SocietyModel.find({ isActive: true }, { _id: 1 }).lean();
  let sent = 0;
  for (const s of societies) {
    if (!(await claimOnce(`statement:${s._id}:${period}`))) continue;
    try {
      const st = await computeStatement(s._id, period);
      if (st.income.total === 0 && st.expenses.total === 0) continue;
      await notify({
        userIds: await allMemberUserIds(s._id),
        societyId: s._id,
        type: 'statement_ready',
        title: `${st.periodLabel} statement is ready`,
        body: `${formatPaise(st.income.total)} collected, ${formatPaise(st.expenses.total)} spent. Balance ${formatPaise(st.closing)}.`,
        data: { period },
      });
      sent += 1;
    } catch (err) {
      if ((err as { code?: string }).code !== 'BEFORE_OPENING') logger.error({ err, societyId: s._id }, 'statementReady failed');
    }
  }
  return { period, sent };
}

/** Monday 09:30 IST. Unpaid families + open/overdue complaints, to admins. Once per society per ISO week. */
export async function adminWeeklyDigestJob(now = new Date()) {
  const week = isoWeekKey(now);
  const period = periodOf(now);
  const societies = await SocietyModel.find({ isActive: true }, { _id: 1 }).lean();
  let sent = 0;
  for (const s of societies) {
    if (!(await claimOnce(`digest:${s._id}:${week}`))) continue;
    const sid = new Types.ObjectId(String(s._id));
    const [totalDues, unpaid, openComplaints, overdueComplaints] = await Promise.all([
      DueModel.countDocuments({ societyId: sid, period, status: { $ne: 'waived' } }),
      DueModel.countDocuments({ societyId: sid, period, status: { $in: ['pending', 'partial'] } }),
      ComplaintModel.countDocuments({ societyId: sid, status: { $in: ACTIVE_STATUSES } }),
      ComplaintModel.countDocuments({ societyId: sid, status: { $in: ACTIVE_STATUSES }, nextUpdateDueAt: { $lte: now } }),
    ]);
    if (totalDues === 0 && openComplaints === 0) continue;
    await notify({
      userIds: await adminUserIds(sid),
      societyId: sid,
      type: 'admin_digest',
      title: 'Weekly summary',
      body: `${unpaid} of ${totalDues} families haven't paid for ${periodLabel(period)}. ${openComplaints} open complaints (${overdueComplaints} overdue).`,
      data: { period },
    });
    sent += 1;
  }
  return { week, sent };
}

/** Daily 03:00 IST. Marks invites past expiry as expired. (Expired notices are filtered by query.) */
export async function dailyCleanupJob(now = new Date()) {
  const r = await InviteModel.updateMany({ status: 'pending', expiresAt: { $lt: now } }, { $set: { status: 'expired' } });
  return { invitesExpired: r.modifiedCount };
}
