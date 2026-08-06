import { createRouter, createWebHashHistory } from 'vue-router'
import { setActiveDeviceId } from '../api/deviceContext'

const EmptyRouteView = {
  render: () => null,
}

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: EmptyRouteView,
    },
    {
      path: '/device/:deviceId',
      name: 'device-home',
      component: EmptyRouteView,
    },
    {
      path: '/device/:deviceId/thread/:threadId',
      name: 'device-thread',
      component: EmptyRouteView,
    },
    {
      path: '/device/:deviceId/skills',
      name: 'device-skills',
      component: EmptyRouteView,
    },
    {
      path: '/device/:deviceId/automations',
      name: 'device-automations',
      component: EmptyRouteView,
    },
    {
      path: '/thread/:threadId',
      name: 'thread',
      component: EmptyRouteView,
    },
    {
      path: '/skills',
      name: 'skills',
      component: EmptyRouteView,
    },
    {
      path: '/automations',
      name: 'automations',
      component: EmptyRouteView,
    },
    {
      path: '/new-thread',
      redirect: { name: 'home' },
    },
    { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
  ],
})

router.beforeEach((to) => {
  if (to.params.deviceId !== undefined) {
    setActiveDeviceId(to.params.deviceId)
  }
  return true
})

export default router
