// Safe to publish: the publishable key only grants what row-level security
// allows, and every policy is scoped to auth.uid(). The service-role key
// must NEVER appear here — it lives in agent-host/.env only.
window.CONFIG = {
  supabaseUrl: 'https://leodfcfgqhkrohsnppbw.supabase.co',
  supabaseAnonKey: 'sb_publishable_5a8q_2butrZ_WC1-Fl7cnw_XYzlNDAq',
};
