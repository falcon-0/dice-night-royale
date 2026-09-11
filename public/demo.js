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
  { label:'Night', kicker:'NIGHT PASS', title:'Small plan, real advantages', message:'Night adds five seconds on demand and saves half your pot if time runs out.', icon:'⏱', active:0, plan:'night' },
  { label:'Royale', kicker:'ROYALE PLAN', title:'Protection when the table turns', message:'Royale includes Night, plus a bust rescue and one automatic Freeze block.', icon:'↻', active:2, plan:'royale' },
  { label:'Legend', kicker:'LEGEND PLAN', title:'The complete power loadout', message:'Legend adds Power Bank, Skull Guard, and one zero-cost Royal Freeze.', icon:'♛', active:0, plan:'legend' },
  { label:'Normal', kicker:'NORMAL DIE', title:'Build the pot safely', message:'FALCON rolls 5. The live feed updates for every player.', icon:'⚄', active:0, pot:5, risk:22, die:'normal', coach:'5 points is a light pot. Normal is the calmer build.' },
  { label:'Bank', kicker:'BANK POINTS', title:'Lock the pot into your score', message:'FALCON taps Bank points. The 5-point pot is now safely added to the big score.', icon:'💰', active:0, pot:0, scores:[45,35,28,18], bank:true, coach:'Banking protects your turn pot before the next player begins.' },
  { label:'Deadly', kicker:'DEADLY RISK DIE', title:'Take the dangerous route', message:'ISSA risks five skull faces and lands a +20 reward.', icon:'☠', active:1, pot:20, risk:50, die:'deadly', scores:[40,55,28,18], coach:'Deadly pays big, but half its opening faces are skulls.' },
  { label:'Freeze', kicker:'TACTICAL POWER', title:'Freeze a rival for 5 points', message:'JOY freezes ISSA. ISSA will miss the next turn.', icon:'❄', active:2, scores:[40,55,23,18], coach:'JOY spent 5 saved points. The dice odds did not change.' },
  { label:'Time +5', kicker:'NIGHT POWER', title:'Five more seconds to decide', message:'FALCON uses Time Boost once this match. The turn clock jumps from 3 to 8 seconds.', icon:'⏱', active:0, effect:'time', coach:'Time Boost is a real clock extension, not just an animation.' },
  { label:'Timeout', kicker:'NIGHT PASSIVE', title:'Half the pot survives timeout', message:'Timeout Saver automatically banks 10 of a 20-point pot instead of losing everything.', icon:'💰', active:0, pot:0, scores:[50,55,23,18], effect:'timeout', coach:'Timeout Saver activates automatically once per match.' },
  { label:'2nd Chance', kicker:'ROYALE POWER', title:'The bust does not win', message:'JOY arms Second Chance. Her next bust is cancelled and her 14-point pot is banked.', icon:'↻', active:2, pot:0, scores:[50,55,37,18], effect:'second', coach:'Second Chance ends the turn safely after banking the rescued pot.' },
  { label:'Ice Guard', kicker:'ROYALE PASSIVE', title:'Freeze blocked automatically', message:'ISSA tries to Freeze JOY, but her one-use Ice Guard stops the attack.', icon:'🛡', active:2, effect:'ice', coach:'Ice Guard is automatic and works once each match.' },
  { label:'Power Bank', kicker:'LEGEND POWER', title:'Bank and keep rolling', message:'FALCON secures a 20-point pot without ending the turn, then gets to roll again.', icon:'💎', active:0, pot:0, scores:[70,55,37,18], effect:'bank', coach:'Power Bank gives a real extra decision and a real extra roll.' },
  { label:'Skull Guard', kicker:'LEGEND POWER', title:'A deadly skull becomes +10', message:'FALCON arms Skull Guard, rolls the Deadly Risk Die, and converts the skull into ten points.', icon:'🛡', active:0, pot:10, scores:[70,55,37,18], effect:'skull', die:'deadly', coach:'Skull Guard works on one Deadly Risk skull per match.' },
  { label:'Royal Freeze', kicker:'LEGEND POWER', title:'Freeze without paying five points', message:'FALCON uses the once-per-match Royal Freeze at zero cost.', icon:'♛', active:0, scores:[70,55,37,18], effect:'royal', coach:'Royal Freeze keeps all saved points while disabling one rival turn.' },
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
  const copy={
    time:['NIGHT POWER','+5 SECONDS','the clock is really extended','⏱'],
    timeout:['TIMEOUT SAVER','10 POINTS BANKED','half the pot survives','💰'],
    second:['SECOND CHANCE','BUST RESCUED','14 points safely banked','↻'],
    ice:['ICE GUARD','FREEZE BLOCKED','JOY keeps her next turn','🛡'],
    bank:['POWER BANK','20 POINTS SECURED','FALCON keeps the turn','💎'],
    skull:['SKULL GUARD','SKULL → +10','deadly risk defeated','🛡'],
    royal:['ROYAL FREEZE','ZERO POINT COST','ISSA loses the next turn','♛']
  }[type];
  if(!copy)return;
  panel.querySelector('small').textContent=copy[0];panel.querySelector('strong').textContent=copy[1];panel.querySelector('em').textContent=copy[2];panel.querySelector('span').textContent=copy[3];
  panel.classList.remove('show');void panel.offsetWidth;panel.classList.add('show');
}
function showPlan(planId){
  const plans={
    night:{name:'NIGHT PASS',price:'₦200',days:'7 DAYS',title:'Start with two real match advantages.',benefits:['+5-second Time Boost','Timeout Saver: bank half','Exact risk coach','Leader-gap tracker','Detailed live stats','Premium reactions']},
    royale:{name:'ROYALE',price:'₦500',days:'30 DAYS',title:'Protect your points and your turns.',benefits:['Everything in Night','Second Chance: rescue bust','Ice Guard: block Freeze','Smart bank-or-roll hint','Streak forecast','Personal-best tracker']},
    legend:{name:'LEGEND',price:'₦1,000',days:'60 DAYS',title:'Control the biggest moments.',benefits:['Everything in Royale','Power Bank: keep rolling','Skull Guard: skull becomes +10','Royal Freeze: zero cost','Rival endgame warning','Winner-song choice']}
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
  const activePower={time:0,second:1,bank:2,skull:3}[scene.effect];
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
