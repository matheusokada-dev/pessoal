const USERNAME_DOMAIN = 'studyvault.local';

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${USERNAME_DOMAIN}`;
}

export function emailToUsername(email?: string): string {
  return email?.split('@')[0] || 'usuário';
}
