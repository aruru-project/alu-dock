import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import dockIconUrl from '../../../assets/icon.svg'
import './webconsole.css'
import './styles.css'
import './conversation.css'
import './extension-ui.css'

document.body.classList.add('alu-terminal-body')
const appIcon = document.querySelector<HTMLLinkElement>('#app-icon')
if (appIcon) appIcon.href = dockIconUrl
createApp(App).use(createPinia()).mount('#app')
