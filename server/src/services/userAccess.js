import {getDb} from '../db/index.js';
import {getSettings} from './settings.js';
import {forbidden} from '../lib/errors.js';

export const ACCESS_FEATURES=['sendFiles','sendImages','sendVideos','sendAudio','connectVoice','speak','video','screenShare'];
export const ACCESS_LIMITS=['maxOwnedGroups','maxJoinedGroups','maxCreatedChannels','maxChannelsPerGroup'];
export async function userAccess(userId,db=getDb()){
 const settings=await getSettings(db);
 const row=await db.get('SELECT policy FROM user_access_policies WHERE user_id=?',[userId]);
 const overrides=row?JSON.parse(row.policy):{};
 const defaults={maxOwnedGroups:settings.default_max_owned_groups,maxJoinedGroups:settings.default_max_joined_groups,maxCreatedChannels:settings.default_max_created_channels,maxChannelsPerGroup:settings.default_max_channels_per_group};
 for(const key of ACCESS_FEATURES)defaults[key]=settings['default_'+key];
 return {defaults,overrides,effective:{...defaults,...overrides}};
}
export async function assertUserFeature(userId,feature){
 if(!(await userAccess(userId)).effective[feature])throw forbidden('This account is not allowed to use '+feature+'.');
}
export async function assertUserLimit(userId,key,count,db=getDb()){
 const limit=(await userAccess(userId,db)).effective[key];
 if(count>=limit)throw forbidden('Account limit reached: '+key+' ('+limit+').');
}
export async function assertUploadAccess(userId,mime){
 await assertUserFeature(userId,'sendFiles');
 const key=mime.startsWith('image/')?'sendImages':mime.startsWith('video/')?'sendVideos':mime.startsWith('audio/')?'sendAudio':null;
 if(key)await assertUserFeature(userId,key);
 // The encrypted container hides its media type. Require all media grants.
 if(mime==='application/vnd.zdis.encrypted')for(const feature of ['sendImages','sendVideos','sendAudio'])await assertUserFeature(userId,feature);
}
