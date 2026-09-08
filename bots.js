const BOT_STYLES = Object.freeze({
  careful: Object.freeze({ id: 'careful', name: 'Careful', bankAt: 10, riskDieChance: 0.02, freezeChance: 0.08 }),
  balanced: Object.freeze({ id: 'balanced', name: 'Balanced', bankAt: 16, riskDieChance: 0.06, freezeChance: 0.14 }),
  bold: Object.freeze({ id: 'bold', name: 'Bold', bankAt: 23, riskDieChance: 0.13, freezeChance: 0.2 })
});

const BOT_NAMES = Object.freeze([
  'Nova Bot', 'Rook Bot', 'Mango Bot', 'Pixel Bot', 'Orbit Bot',
  'Comet Bot', 'Echo Bot', 'Lucky Bot', 'Jinx Bot'
]);

function botStyle(value) {
  return BOT_STYLES[value] || BOT_STYLES.balanced;
}

function availableBotName(players = []) {
  const used = new Set(players.map(player => String(player.name).toLocaleLowerCase()));
  return BOT_NAMES.find(name => !used.has(name.toLocaleLowerCase())) || `Practice Bot ${players.length + 1}`;
}

function leadingOpponent(room, bot) {
  return room.players
    .filter(player => player.id !== bot.id)
    .sort((left, right) => right.score - left.score || left.joinedAt - right.joinedAt)[0];
}

/**
 * Choose one legal-looking move. The server still runs the result through its
 * normal action() function, which remains the authority for every rule.
 */
function chooseBotAction(room, bot, random = Math.random) {
  const style = botStyle(bot.botStyle);
  const leader = leadingOpponent(room, bot);
  const target = room.mode === 'showdown' ? null : room.targetScore;

  if (room.turnScore > 0 && target && bot.score + room.turnScore >= target) {
    return { type: 'hold' };
  }

  if (room.turnScore === 0 && !room.freezeUsed && bot.score >= 5 && leader
      && leader.score >= bot.score + 12 && !leader.frozen && random() < style.freezeChance) {
    return { type: 'freeze', targetId: leader.id };
  }

  const showdownLastTurn = room.mode === 'showdown'
    && (bot.turnsTaken || 0) + 1 >= (room.showdownRoundLimit || 5);
  if (room.turnScore > 0 && (room.turnScore >= style.bankAt || showdownLastTurn)) {
    return { type: 'hold' };
  }

  if (room.turnScore === 0 && !room.doubleUsed && random() < style.riskDieChance) {
    return { type: 'risk_die' };
  }

  const riskPercent = Number(room.riskPercent || 0);
  if (room.turnScore > 0 && (riskPercent >= 55 || random() < room.turnScore / (style.bankAt * 4))) {
    return { type: 'hold' };
  }

  return { type: 'roll' };
}

module.exports = { BOT_STYLES, availableBotName, botStyle, chooseBotAction };
