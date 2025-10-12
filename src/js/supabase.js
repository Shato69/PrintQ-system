import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

  // Your Supabase project credentials
  const supabaseUrl = 'https://ncpxwgbvvfqybqzckhrs.supabase.co';
  const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jcHh3Z2J2dmZxeWJxemNraHJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkzNjY0NDYsImV4cCI6MjA3NDk0MjQ0Nn0.WWamS_9o1KqmlL3M6Gj27JjxmqCyxhzzfxpOqqtWDlU";
  export const supabase = createClient(supabaseUrl, supabaseKey);

