export type Category = 'working' | 'staying' | 'custom';
export type FilterType = 'all' | Category | 'paid' | 'partial' | 'pending' | 'overdue';

export interface Resident {
  id: string;
  resident_no: number;
  full_name: string | null;
  contact_number: string | null;
  room_number: string | null;
  bed_number: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeeSchedule {
  id: string;
  resident_id: string;
  category: Category;
  monthly_fee: number;
  effective_month: string;
}

export interface MonthlyCharge {
  resident_id: string;
  billing_month: string;
  category: Category;
  monthly_fee: number;
  due_date: string;
}

export interface Payment {
  id: string;
  resident_id: string;
  billing_month: string;
  amount: number;
  payment_date: string;
  note: string | null;
  created_at: string;
}

export interface ResidentRow extends Resident {
  category: Category | null;
  monthlyFee: number;
  paid: number;
  balance: number;
  dueDate: string | null;
  status: 'paid' | 'partial' | 'pending' | 'overdue' | 'empty';
  paymentDates: string[];
}
