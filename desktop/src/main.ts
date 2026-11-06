import {mountAgent} from './agent';
import {mountDesktop} from './native-desktop';
import './app.css';
mountAgent(async()=>{},false);
void mountDesktop().catch(()=>{const status=document.querySelector('.octopus-status');if(status)status.textContent='本机服务连接失败，请重启章鱼';});
