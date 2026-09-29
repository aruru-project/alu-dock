import './styles/tokens.css'
import './styles/base.css'
import './styles/controls.css'
import './styles/host-connection.css'
import './styles/dialog.css'
import './styles/conversation.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import dockIconUrl from '../../../assets/icon.svg'

document.body.classList.add('alu-terminal-body')
const appIcon = document.querySelector<HTMLLinkElement>('#app-icon')
if (appIcon) appIcon.href = dockIconUrl
createApp(App).use(createPinia()).mount('#app')
