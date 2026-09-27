import type { AssistedLoginProvider, AssistedLoginProviderId } from '../types.js';
import { linuxDoProvider } from './linuxdo.js';
import { gitHubProvider } from './github.js';

export const assistedLoginProviders: Record<AssistedLoginProviderId, AssistedLoginProvider> = {
  linuxdo: linuxDoProvider,
  github: gitHubProvider,
};

export const assistedLoginProviderIds = Object.keys(assistedLoginProviders) as AssistedLoginProviderId[];

export function getAssistedLoginProvider(id: string): AssistedLoginProvider | null {
  const normalized = (id || '').trim().toLowerCase();
  return assistedLoginProviders[normalized as AssistedLoginProviderId] || null;
}
