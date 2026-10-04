export const BOT_VARIABLES = ['username','displayName','mention','userId','avatar','server','memberCount','joinedAt','createdAt'];
const SELF_ROLE_PERMISSIONS=new Set(['viewChannel','readMessageHistory','sendMessages','addReactions','attachFiles','embedLinks','useExternalEmojis','useExternalStickers','useApplicationCommands']);
export function safeSelfRole(role){return !role.is_default&&JSON.parse(role.permissions||'[]').every(permission=>SELF_ROLE_PERMISSIONS.has(permission));}
export function renderBotTemplate(template, values) {
  return String(template).replace(/\{([a-zA-Z]+)\}/g, (token,key) => Object.hasOwn(values,key) ? String(values[key] ?? '') : token);
}
export const BOT_DEFAULTS = {
  welcomer: { enabled:false, welcomeChannelId:null, goodbyeChannelId:null, welcomeMessage:'Welcome {mention} to **{server}**! You are member #{memberCount}.', goodbyeMessage:'Goodbye {displayName}. Thanks for being part of {server}.', bannerEnabled:true, bannerTitle:'Welcome, {displayName}!', bannerSubtitle:'You are member #{memberCount} · {server}', goodbyeTitle:'Goodbye, {displayName}', bannerColor:'#5865f2', textColor:'#ffffff', backgroundAttachmentId:null, autoRoleIds:[] },
  moderator: { protectionEnabled:false,protectionWhitelistIds:[],protectedUserIds:[],protectedRoleIds:[],maxActionsPerWindow:5,protectionWindowSeconds:60,logsEnabled:false,temporaryVoiceEnabled:false,temporaryVoiceCategoryId:null,temporaryVoiceIdleSeconds:300,temporaryInvitesEnabled:false,starboardEnabled:false,starboardChannelId:null,starboardThreshold:3,starboardEmoji:"\u2b50",antiRaidEnabled:false,maxJoinsPerWindow:10,joinWindowSeconds:60,minAccountAgeHours:0,enabled:false, logChannelId:null, blockedWords:[], blockLinks:false, blockInvites:true, allowedDomains:[], maxMentions:5, maxMessages:6, windowSeconds:8, maxRepeats:3, capsPercent:80, minCapsLength:15, maxAttachments:5, action:'block', timeoutSeconds:600, warningThreshold:3, exemptRoleIds:[], exemptChannelIds:[], levelingEnabled:false,voiceXpPerMinute:15, xpPerMessage:15, xpCooldownSeconds:60, levelRewards:[], selfRoleIds:[], responses:[], ticketsEnabled:false, ticketCategoryId:null, ticketSupportRoleIds:[] }
};
export function matchBotRule(content, count, settings, history=[], now=Date.now()) {
  const text=String(content).normalize('NFKC'), lower=text.toLocaleLowerCase();
  if(settings.blockedWords.some(word=>lower.includes(word.normalize('NFKC').toLocaleLowerCase())))return 'Blocked keyword';
  const urls=[...text.matchAll(/https?:\/\/[^\s<>]+/gi)].map(m=>m[0]);
  if(settings.blockInvites && /(?:discord(?:app)?\.com\/invite|discord\.gg\/|\/invites?\/[a-z0-9_-]+)/i.test(text))return 'Invite links';
  if(settings.blockLinks && urls.some(raw=>{try{const host=new URL(raw).hostname.toLowerCase();return !settings.allowedDomains.some(domain=>host===domain||host.endsWith('.'+domain));}catch{return true;}}))return 'Unapproved link';
  if((text.match(/@[a-z0-9._-]{3,32}|@(everyone|here)\b/gi)||[]).length>settings.maxMentions)return 'Mention spam';
  if(count>settings.maxAttachments)return 'Attachment spam';
  const letters=text.match(/[a-z]/gi)||[], capitals=text.match(/[A-Z]/g)||[];
  if(letters.length>=settings.minCapsLength && capitals.length*100/letters.length>=settings.capsPercent)return 'Excessive capitals';
  const recent=history.filter(item=>now-item.at<settings.windowSeconds*1000);
  if(recent.length>=settings.maxMessages)return 'Message flood';
  if(recent.filter(item=>item.text===lower).length>=settings.maxRepeats)return 'Repeated messages';
  return null;
}
export function escapeSvg(value) {return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));}
export function levelForXp(xp){return Math.floor(Math.sqrt(Math.max(0,xp)/100));}
