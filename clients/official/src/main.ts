import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './webconsole.css'
import './styles.css'
import './extension-ui.css'

document.body.classList.add('alu-terminal-body')
createApp(App).use(createPinia()).mount('#app')
