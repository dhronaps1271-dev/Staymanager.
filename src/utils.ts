import type { Category, FeeSchedule, MonthlyCharge, Payment, Resident, ResidentRow } from '../types';

export const euro = (value: number) => new Intl.NumberFormat('en-IE', {
  style: 'currency', currency: 'EUR', minimumFractionDigits: 2,
}).format(Number.isFinite(value) ? value : 0);

export const monthLabel = (month: string) => new Intl.DateTimeFormat('en-GB', {
  month: 'long', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`));

export const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

export const firstOfNextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 1)).toISOString().slice(0, 10);
};

export const monthDate = (input: string) => `${input.slice(0, 7)}-01`;

export const feeForCategory = (category: Category, customFee = 0) => {
  if (category === 'working') return 70;
  if (category === 'staying') return 180;
  return Math.max(0, Number(customFee) || 0);
};

export const categoryLabel = (category: Category | null) => {
  if (category === 'working') return 'Working';
  if (category === 'staying') return 'Staying';
  if (category === 'custom') return 'Custom fee';
  return 'Not assigned';
};

export function activeSchedule(schedules: FeeSchedule[], residentId: string, month: string) {
  return schedules
    .filter(s => s.resident_id === residentId && s.effective_month <= monthDate(month))
    .sort((a, b) => b.effective_month.localeCompare(a.effective_month))[0];
}

export function buildResidentRows(
  residents: Resident[], schedules: FeeSchedule[], charges: MonthlyCharge[], payments: Payment[], month: string,
): ResidentRow[] {
  const monthKey = monthDate(month);
  const today = dateForInput();
  const chargeById = new Map(charges.map(c => [c.resident_id, c]));
  const monthPayments = payments.filter(p => p.billing_month === monthKey);
  const paidById = new Map<string, number>();
  const datesById = new Map<string, string[]>();
  monthPayments.forEach(p => {
    paidById.set(p.resident_id, (paidById.get(p.resident_id) ?? 0) + Number(p.amount));
    datesById.set(p.resident_id, [...(datesById.get(p.resident_id) ?? []), p.payment_date]);
  });

  return residents.map(resident => {
    const schedule = activeSchedule(schedules, resident.id, month);
    const charge = chargeById.get(resident.id);
    const isEmpty = !resident.full_name?.trim();
    const fee = Number(charge?.monthly_fee ?? schedule?.monthly_fee ?? 0);
    const paid = isEmpty ? 0 : Number(paidById.get(resident.id) ?? 0);
    const balance = isEmpty ? 0 : Math.max(0, fee - paid);
    const dueDate = charge?.due_date ?? null;
    let status: ResidentRow['status'] = 'empty';
    if (!isEmpty) {
      if (balance <= 0) status = 'paid';
      else if (dueDate && today > dueDate) status = 'overdue';
      else if (paid > 0) status = 'partial';
      else status = 'pending';
    }
    return {
      ...resident,
      category: (charge?.category ?? schedule?.category ?? null) as Category | null,
      monthlyFee: fee,
      paid,
      balance,
      dueDate,
      status,
      paymentDates: datesById.get(resident.id) ?? [],
    };
  }).sort((a, b) => a.resident_no - b.resident_no);
}

export const dateForInput = (date = new Date()) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};
