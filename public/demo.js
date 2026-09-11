const $ = selector => document.querySelector(selector);
const players = [
  { name:'FALCON', tag:'FOUNDER · LEGEND', score:40, plan:'legend' },
  { name:'ISSA', tag:'×4 CHAMPION', score:35 },
  { name:'JOY', tag:'ROYALE MEMBER', score:28, plan:'royale' },
  { name:'TUNDE', tag:'LEVEL 3', score:18 }
];
const scenes = [
  { label:'Create', kicker:'ROOM CREATED', title:'FALCON opens the table', message:'Friends can join from any phone using one shared link.', icon:'✦', active:0, pot:0, risk:16 },
  { label:'Join', kicker:'NINE PLAYER ROOM', title:'Everybody joins in seconds', message:'Profiles reconnect automatically, while guests can jump straight in.', icon:'＋', active:0, chat:true },
  { label:'Night', kicker:'NIGHT PASS', title:'The first Club plan', message:'See the smart essentials included from ₦200.', icon:'✦', active:0, plan:'night' },
  { label:'Royale', kicker:'ROYALE PLAN', title:'More style and more live help', message:'Royale adds deeper strategy, animations, and Hype Storm.', icon:'⚡', active:2, plan:'royale' },
  { label:'Legend', kicker:'LEGEND PLAN', title:'The complete Night Club experience', message:'Legend unlocks all helpers and all three social powers.', icon:'♛', active:0, plan:'legend' },
  { label:'Normal', kicker:'NORMAL DIE', title:'Build the pot safely', message:'FALCON rolls 5. The live feed updates for every player.', icon:'⚄', active:0, pot:5, risk:22, die:'normal', coach:'5 points is a light pot. Normal is the calmer build.' },
  { label:'Bank', kicker:'BANK POINTS', title:'Lock the pot into your score', message:'FALCON taps Bank points. The 5-point pot is now safely added to the big score.', icon:'💰', active:0, pot:0, scores:[45,35,28,18], bank:true, coach:'Banking protects your turn pot before the next player begins.' },
  { label:'Deadly', kicker:'DEADLY RISK DIE', title:'Take the dangerous route', message:'ISSA risks five skull faces and lands a +20 reward.', icon:'☠', active:1, pot:20, risk:50, die:'deadly', scores:[40,55,28,18], coach:'Deadly pays big, but half its opening faces are skulls.' },
  { label:'Freeze', kicker:'TACTICAL POWER', title:'Freeze a rival for 5 points', message:'JOY freezes ISSA. ISSA will miss the next turn.', icon:'❄', active:2, scores:[40,55,23,18], coach:'JOY spent 5 saved points. The dice odds did not change.' },
  { label:'Hype', kicker:'ROYALE POWER', title:'Hype Storm hits the room', message:'A once-per-match reaction storm brings the whole table alive.', icon:'⚡', active:2, effect:'hype' },
  { label:'Challenge', kicker:'LEGEND POWER', title:'The leader gets called out', message:'FALCON challenges ISSA for the crown—pure drama, zero score advantage.', icon:'⚔', active:0, effect:'challenge' },
  { label:'Spotlight', kicker:'LEGEND POWER', title:'FALCON owns the moment', message:'Legend Spotlight launches a table-wide blue-and-gold takeover.', icon:'✦', active:0, effect:'spotlight' },
  { label:'Winner', kicker:'MATCH COMPLETE', title:'The crown is claimed', message:'Profiles, achievements, records, and the leaderboard save automatically.', icon:'♛', active:0, scores:[120,92,74,66], winner:true }
];
let index=0, playing=true, started=Date.now(), elapsed=0;
const sceneMs=new URLSearchParams(location.search).has('record')?2100:2600;

function renderPlayers(scene){
  const scores=scene.scores||players.map(player=>player.score);
  $('#players').innerHTML=players.map((player,i)=>`<article class="demo-player ${scene.active===i?'active':''} ${player.plan||''}"><div class="name"><span>${player.name}</span><i>${player.tag}</i></div><strong>${scores[i]}</strong><small>${i===scene.active?'CURRENT TURN':'SAVED POINTS'}</small></article>`).join('');
}
function showEffect(type){
  const panel=$('#takeover');
  const copy={hype:['HYPE STORM','JOY','shook the whole table','⚡'],challenge:['CROWN CHALLENGE','FALCON  VS  ISSA','the crown is on the line','⚔'],spotlight:['LEGEND SPOTLIGHT','FALCON','owns the night','✦']}[type];
  if(!copy)return;
  panel.querySelector('small').textContent=copy[0];panel.querySelector('strong').textContent=copy[1];panel.querySelector('em').textContent=copy[2];panel.querySelector('span').textContent=copy[3];
  panel.classList.remove('show');void panel.offsetWidth;panel.classList.add('show');
}
function showPlan(planId){
  const plans={
    night:{name:'NIGHT PASS',price:'₦200',days:'7 DAYS',title:'Start the night smarter.',benefits:['Smart turn alerts','Exact risk coach','Leader-gap tracker','3-second pace cue','Premium reactions','Glass player card']},
    royale:{name:'ROYALE',price:'₦500',days:'30 DAYS',title:'Play with more insight and style.',benefits:['Everything in Night','Streak forecast','Bank-or-roll hint','Mode strategy tips','Personal-best tracker','Hype Storm power']},
    legend:{name:'LEGEND',price:'₦1,000',days:'60 DAYS',title:'Own every moment of game night.',benefits:['Everything in Royale','Personal match recap','Rival endgame warning','Crown Challenge power','Legend Spotlight power','Winner song choice']}
  };
  const plan=plans[planId];if(!plan)return;
  const panel=$('#plan-showcase');panel.className=`plan-showcase ${planId}`;
  $('#plan-demo-label').textContent=plan.name;$('#plan-demo-price').textContent=plan.price;$('#plan-demo-duration').textContent=plan.days;$('#plan-demo-title').textContent=plan.title;$('#plan-demo-benefits').innerHTML=plan.benefits.map(item=>`<b>✓ ${item}</b>`).join('');
  void panel.offsetWidth;panel.classList.add('show');
}
function renderScene(next){
  index=Math.max(0,Math.min(scenes.length-1,next));const scene=scenes[index];
  $('#scene-kicker').textContent=scene.kicker;$('#scene-title').textContent=scene.title;$('#scene-message').textContent=scene.message;$('#scene-icon').textContent=scene.icon;
  $('#turn-pot').textContent=scene.pot??0;$('#risk-label').textContent=`${scene.risk??16}% bust risk`;$('#coach').textContent=scene.coach||'Live helpers explain the risk without changing the odds.';$('#gap').textContent=index>3?'Leader gap 15':'Leader gap 0';
  $('#chat-new').classList.toggle('show',Boolean(scene.chat)||index>1);renderPlayers(scene);
  $('#normal-die').classList.toggle('rolling',scene.die==='normal');$('#deadly-die').classList.toggle('rolling',scene.die==='deadly');
  $('#bank-button').classList.toggle('active',Boolean(scene.bank));
  $('#freeze-demo-button').classList.toggle('active',scene.label==='Freeze');
  const activePower={hype:0,challenge:1,spotlight:2}[scene.effect];
  $('#power-buttons').querySelectorAll('button').forEach((button,i)=>button.style.opacity=activePower===i?'1':'.5');
  $('#chapters').querySelectorAll('button').forEach((button,i)=>button.classList.toggle('active',i===index));
  if(scene.effect)showEffect(scene.effect);
  if(scene.plan)showPlan(scene.plan);else $('#plan-showcase').className='plan-showcase';
  if(scene.winner){const winner=$('#winner');winner.classList.remove('show');void winner.offsetWidth;winner.classList.add('show')}
  else $('#winner').classList.remove('show');
  started=Date.now();elapsed=0;
}
$('#chapters').innerHTML=scenes.map((scene,i)=>`<button data-scene="${i}">${i+1}. ${scene.label}</button>`).join('');
$('#chapters').addEventListener('click',event=>{const button=event.target.closest('[data-scene]');if(button)renderScene(Number(button.dataset.scene))});
$('#restart').addEventListener('click',()=>{playing=true;$('#play-pause').textContent='Pause';renderScene(0)});
$('#play-pause').addEventListener('click',()=>{playing=!playing;$('#play-pause').textContent=playing?'Pause':'Play';started=Date.now()-elapsed});
function tick(){
  if(playing){elapsed=Date.now()-started;const overall=((index+Math.min(1,elapsed/sceneMs))/scenes.length)*100;$('#progress').style.width=`${overall}%`;$('#scene-time').textContent=`${Math.max(0,(sceneMs-elapsed)/1000).toFixed(1)}s`;if(elapsed>=sceneMs){if(index<scenes.length-1)renderScene(index+1);else playing=false}}
  requestAnimationFrame(tick);
}
renderScene(0);tick();
