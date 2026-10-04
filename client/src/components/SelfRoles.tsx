import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useRealtime } from '../store/realtime';
import { Icon } from './Icon';

type RoleChoice={id:string;name:string;color:string|null;assigned:boolean};
export function SelfRoles({groupId}:{groupId:string}){
 const {locale}=useI18n(),fa=locale==='fa',socket=useRealtime(state=>state.socket);
 const [roles,setRoles]=useState<RoleChoice[]>([]),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const path=`/api/builtin-bots/groups/${groupId}/self-roles`;
 useEffect(()=>{
  let current=true;setRoles([]);setOpen(false);setError('');
  const refresh=()=>{void api.get<{roles:RoleChoice[]}>(path).then(result=>{if(current)setRoles(result.roles);}).catch(()=>{});};
  const changed=(payload:{groupId:string})=>{if(payload.groupId===groupId)refresh();};
  refresh();socket?.on('group:member-updated',changed);socket?.on('connect',refresh);
  return()=>{current=false;socket?.off('group:member-updated',changed);socket?.off('connect',refresh);};
 },[path,groupId,socket]);
 if(!roles.length)return null;
 return <><button className="composer-btn" type="button" aria-label={fa?'انتخاب نقش':'Choose server roles'} title={fa?'انتخاب نقش':'Choose server roles'} onClick={()=>setOpen(value=>!value)}><Icon name="users" size={19}/></button>
  {open?<div className="media-picker emoji-popover" role="dialog" aria-label={fa?'انتخاب نقش':'Choose server roles'}>
   <header><strong>{fa?'نقش‌های من':'My server roles'}</strong><button onClick={()=>setOpen(false)} aria-label="Close role picker">×</button></header>
   <p className="faint">{fa?'نقش‌های مجاز سرور را انتخاب یا حذف کن.':'Choose or remove roles offered by this server.'}</p>
   <div className="self-role-choices">{roles.map(role=><button className="btn" key={role.id} aria-pressed={role.assigned} disabled={busy} onClick={()=>{
    setBusy(true);setError('');void api.post<{roles:RoleChoice[]}>(path,{roleId:role.id,remove:role.assigned}).then(result=>setRoles(result.roles)).catch(e=>setError(e.message)).finally(()=>setBusy(false));
   }}>{role.assigned?'✓ ':''}{role.name}</button>)}</div>
   {error?<p role="alert">{error}</p>:null}
  </div>:null}
 </>;
}
