// Built at runtime so no key-shaped literal ever sits in the repository.
export const FAKE_KEYS: Record<string, string> = {
  anthropic: ['sk', 'ant', 'api03', 'A1b2'.repeat(10)].join('-'),
  'openai-scoped': ['sk', 'proj', 'Ab1_'.repeat(12)].join('-'),
  'openai-legacy': ['sk', 'Ab1'.repeat(16)].join('-'),
  google: `${'AI'}za${'Sy'}${'x1_'.repeat(11)}`,
  zai: `${'0123456789abcdef'.repeat(2)}.${'AbCd1234'.repeat(2)}`,
  github: `${'gh'}p_${'A1'.repeat(18)}`,
  'github-pat': `${'github'}_pat_${'A1_'.repeat(20)}`,
  // Google's 2026 auth-key transition: AI Studio now also issues AQ.Ab… keys.
  'google-auth': `${'AQ'}.Ab${'x1_'.repeat(11)}`,
}
