import { navigation, navigationSections } from './data.js';

function hasAnyPermission(permissions, requiredPermissions = []) {
  return requiredPermissions.length === 0 || requiredPermissions.some((permission) => permissions.has(permission));
}

export function getVisibleNavigation(permissions = []) {
  const granted = permissions instanceof Set ? permissions : new Set(permissions);
  return navigationSections.map((section) => ({
    ...section,
    items: navigation
      .filter((item) => section.keys.includes(item.key) && hasAnyPermission(granted, item.permissions))
      .map((item) => ({
        ...item,
        children: (item.children || []).filter((child) => hasAnyPermission(granted, child.permissions || [child.permission])),
      })),
  })).filter((section) => section.items.length > 0);
}

export function getNavigationForDisplay(permissions = []) {
  const granted = permissions instanceof Set ? permissions : new Set(permissions);
  return navigationSections.map((section) => ({
    ...section,
    items: navigation
      .filter((item) => section.keys.includes(item.key))
      .map((item) => ({
        ...item,
        allowed: hasAnyPermission(granted, item.permissions),
        children: (item.children || []).map((child) => ({
          ...child,
          allowed: hasAnyPermission(granted, child.permissions || [child.permission]),
        })),
      })),
  }));
}

export function resolveNavigationRoute(key, permissions = []) {
  const granted = permissions instanceof Set ? permissions : new Set(permissions);
  for (const section of getVisibleNavigation(granted)) {
    for (const item of section.items) {
      if (item.key === key) return { key, menu: item.menu };
      const child = item.children.find((entry) => entry.key === key);
      if (child) return { key, menu: child.menu, tab: child.tab };
    }
  }
  return null;
}

export function getNavigationKeyFromHash(hash) {
  return String(hash || '').replace(/^#\/?/, '').split(/[/?]/, 1)[0] || 'dashboard';
}
