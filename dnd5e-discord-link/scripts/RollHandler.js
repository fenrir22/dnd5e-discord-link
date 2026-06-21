export class RollHandler {
  static _skillLabel(key) {
    const label = CONFIG.DND5E.skills?.[key]?.label;
    return label ? game.i18n.localize(label) : key;
  }

  static _abilityLabel(key) {
    const label = CONFIG.DND5E.abilities?.[key]?.label;
    return label ? game.i18n.localize(label) : key;
  }

  static async handleRollSkill(actor, skillId, options = {}) {
    let key = skillId;
    let skill = actor.system?.skills?.[key];
    if (!skill) {
      const match = Object.entries(CONFIG.DND5E.skills || {})
        .find(([k, v]) => v.label?.toLowerCase() === skillId.toLowerCase());
      if (match) { key = match[0]; skill = actor.system?.skills?.[key]; }
      if (!skill) throw new Error(`Skill "${skillId}" non trovata`);
    }

    const label = this._skillLabel(key);

    let roll;
    if (!options.advantage && !options.disadvantage && !options.bonus) {
      const result = await actor.rollSkill({ skill: key }, { configure: false }, { create: true });
      roll = Array.isArray(result) ? result[0] : result;
    } else {
      const modifier = skill.total || 0;
      roll = await this._createAndSendRoll(modifier, options, actor, 'skill', label);
    }

    return this._formatRoll(roll, { type: 'skill', name: label });
  }

  static async handleRollAbility(actor, abilityId, options = {}) {
    const ability = actor.system?.abilities?.[abilityId];
    if (!ability) throw new Error(`Abilità "${abilityId}" non trovata`);

    const label = this._abilityLabel(abilityId);

    let roll;
    if (!options.advantage && !options.disadvantage && !options.bonus) {
      const result = await actor.rollAbilityCheck({ ability: abilityId }, { configure: false }, { create: true });
      roll = Array.isArray(result) ? result[0] : result;
    } else {
      const modifier = ability.mod || 0;
      roll = await this._createAndSendRoll(modifier, options, actor, 'ability', label);
    }

    return this._formatRoll(roll, { type: 'ability', name: label });
  }

  static async handleRollSave(actor, abilityId, options = {}) {
    const ability = actor.system?.abilities?.[abilityId];
    if (!ability) throw new Error(`Abilità "${abilityId}" non trovata`);

    const label = this._abilityLabel(abilityId);

    let roll;
    if (!options.advantage && !options.disadvantage && !options.bonus) {
      const result = await actor.rollSavingThrow({ ability: abilityId }, { configure: false }, { create: true });
      roll = Array.isArray(result) ? result[0] : result;
    } else {
      const modifier = ability.save?.value ?? ability.save ?? ability.mod ?? 0;
      roll = await this._createAndSendRoll(modifier, options, actor, 'save', label);
    }

    return this._formatRoll(roll, { type: 'save', name: label });
  }

  static async _createAndSendRoll(modifier, options, actor, type, name) {
    let formula;
    if (options.advantage) {
      formula = '2d20kh';
    } else if (options.disadvantage) {
      formula = '2d20kl';
    } else {
      formula = '1d20';
    }

    if (modifier !== 0) {
      formula += modifier > 0 ? ` + ${modifier}` : ` - ${Math.abs(modifier)}`;
    }

    if (options.bonus) {
      formula += ` + ${options.bonus}`;
    }

    const roll = new Roll(formula, actor.getRollData());
    await roll.evaluate({ async: true });

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `${type === 'skill' ? 'Skill' : type === 'ability' ? 'Ability Check' : 'Saving Throw'}: ${name}`
    });

    return roll;
  }

  static async handleRollAttack(actor, itemId, options = {}) {
    const item = actor.items.get(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);

    let roll;
    const activity = item.system.activities?.find(a => a.type === 'attack');
    if (!activity) throw new Error('Questo oggetto non supporta tiri per colpire');

    const hasOptions = options.advantage || options.disadvantage || options.bonus;
    if (hasOptions) {
      const baseResult = await activity.rollAttack({}, { configure: false }, { create: false });
      const baseRoll = baseResult?.[0];
      if (!baseRoll) throw new Error('Tiro per colpire fallito');

      let formula = baseRoll.formula.replace(/^1d20\b/, options.advantage ? '2d20kh' : '2d20kl');
      if (options.bonus) formula += ` + ${options.bonus}`;

      roll = new Roll(formula, actor.getRollData());
      await roll.evaluate({ async: true });
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `Attack: ${item.name}`
      });
    } else {
      const result = await activity.rollAttack({}, { configure: false }, { create: true });
      roll = Array.isArray(result) ? result[0] : result;
    }

    let damageRoll;
    try {
      const dmg = await this.handleRollDamage(actor, itemId, false);
      if (dmg?.roll) damageRoll = dmg.roll;
    } catch (e) {
      damageRoll = null;
    }

    return {
      ...this._formatRoll(roll, { type: 'attack', name: item.name }),
      damageRoll: damageRoll || null,
    };
  }

  static async handleRollDamage(actor, itemId, critical = false, options = {}) {
    const item = actor.items.get(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);

    const rollData = actor.getRollData();
    const parts = [];

    const add = (d) => {
      if (d.custom?.enabled && d.custom?.formula) parts.push(d.custom.formula);
      else if (d.number && d.denomination) {
        let f = `${d.number}d${d.denomination}`;
        if (critical) f = `${d.number * 2}d${d.denomination}`;
        if (d.bonus) f += ' + ' + d.bonus;
        parts.push(f);
      }
    };

    if (item.system?.damage?.parts) {
      for (const [f] of item.system.damage.parts) {
        parts.push(critical ? f.replace(/(\d+)(d)/g, (_, n, d) => `${parseInt(n) * 2}${d}`) : f);
      }
    }
    if (item.system?.damage?.base) add(item.system.damage.base);
    if (item.system?.damage?.versatile) add(item.system.damage.versatile);
    for (const act of (item.system.activities || [])) {
      for (const dp of (act.damage?.parts || [])) add(dp);
    }

    if (options.bonus) parts.push(options.bonus);

    if (!parts.length) throw new Error('Questo oggetto non ha formule di danno');
    const formula = parts.join(' + ');
    const roll = new (CONFIG.Dice.DamageRoll || Roll)(formula, rollData);
    await roll.evaluate({ async: true });

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `Damage: ${item.name}`
    });

    return this._formatRoll(roll, { type: 'damage', name: item.name });
  }

  static _formatRoll(roll, meta = {}) {
    if (!roll) {
      return { error: 'Roll failed to execute', meta };
    }

    const termsDisplay = (roll.terms || [])
      .filter(t => t.results?.length)
      .map(t => {
        const rolled = t.results.map(r => `${r.result}${r.active === false ? ' (scartato)' : ''}`).join(', ');
        return `${t.number || 1}d${t.faces || '?'} [${rolled}]`;
      })
      .join('; ') || '—';

    return {
      success: true,
      roll: {
        formula: roll.formula,
        total: roll.total,
        result: roll.result,
        termsDisplay,
        terms: roll.terms?.map(t => ({
          type: t.constructor.name,
          faces: t.faces,
          number: t.number,
          results: t.results?.map(r => r.result) || [],
          total: t.total,
        })) || [],
      },
      meta,
    };
  }
}
