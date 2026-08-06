import { normalizeDeviceId } from '../api/deviceContext'
import type { LocationQueryRaw } from 'vue-router'

export type AppRouteView = 'home' | 'thread' | 'skills' | 'automations'

type RouteContext = {
  params: Record<string, unknown>
}

type AppRouteLocation = {
  name: string
  params: Record<string, string>
  query?: LocationQueryRaw
}

const DEVICE_ROUTE_NAMES: Record<AppRouteView, string> = {
  home: 'device-home',
  thread: 'device-thread',
  skills: 'device-skills',
  automations: 'device-automations',
}

export function getAppRouteView(routeName: unknown): AppRouteView | null {
  if (typeof routeName !== 'string') return null
  const normalized = routeName.startsWith('device-') ? routeName.slice('device-'.length) : routeName
  if (normalized === 'home' || normalized === 'thread' || normalized === 'skills' || normalized === 'automations') {
    return normalized
  }
  return null
}

export function buildAppRouteLocation(
  currentRoute: RouteContext,
  view: AppRouteView,
  params: Record<string, string> = {},
  query?: LocationQueryRaw,
): AppRouteLocation {
  const deviceId = normalizeDeviceId(currentRoute.params.deviceId)
  return {
    name: deviceId ? DEVICE_ROUTE_NAMES[view] : view,
    params: deviceId ? { deviceId, ...params } : { ...params },
    ...(query ? { query } : {}),
  }
}
