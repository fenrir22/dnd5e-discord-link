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
    if (!activity) {
      const saveAct = item.system.activities?.find(a => a.type === 'save');
      if (saveAct) {
        const saveDC = actor.system?.attributes?.spelldc || 8 + (actor.system?.abilities?.[saveAct.ability]?.mod || 0) + (actor.system?.attributes?.prof || 2);
        const saveAbilityKey = saveAct.ability || (saveAct.damage?.parts?.[0]?.types?.[0] ? Object.keys(CONFIG.DND5E.abilities || {}).find(k => CONFIG.DND5E.abilities[k]?.label?.toLowerCase().includes(saveAct.damage.parts[0].types[0])) : '') || '';
        const saveLabel = CONFIG.DND5E?.abilities?.[saveAbilityKey]?.label || saveAbilityKey.toUpperCase() || '—';
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          flavor: `${item.name} — Tiro Salvezza CD ${saveDC} ${saveLabel}`,
          content: `<p><strong>CD ${saveDC}</strong> — ${saveLabel}<br>Il bersaglio deve superare il tiro salvezza per subire metà danno.</p>`,
        });
        try {
          await saveAct.use({}, { configure: false });
        } catch {}
        let damageResult;
        try {
          const dmgResult = await saveAct.rollDamage({}, { configure: false }, { create: true });
          const dmgRoll = Array.isArray(dmgResult) ? dmgResult[0] : dmgResult;
          if (dmgRoll) damageResult = this._formatRoll(dmgRoll, { type: 'damage', name: item.name });
        } catch {}
        return {
          type: 'save',
          name: item.name,
          saveDC,
          saveAbility: saveLabel,
          damageRoll: damageResult?.roll || null,
        };
      }
      throw new Error('Questo oggetto non supporta tiri per colpire');
    }

    const hasOptions = options.advantage || options.disadvantage || options.bonus;
    if (hasOptions) {
      const baseResult = await activity.rollAttack({}, { configure: false }, { create: false });
      const baseRoll = baseResult?.[0];
      if (!baseRoll) throw new Error('Tiro per colpire fallito');

      let formula = baseRoll.formula.replace(/^1d20\b/, options.advantage ? '2d20kh' : options.disadvantage ? '2d20kl' : '1d20');
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

    const hasActivities = (item.system.activities || []).some(a => a.damage?.parts?.length);
    if (!hasActivities && item.system?.damage?.parts) {
      for (const [f] of item.system.damage.parts) {
        parts.push(critical ? f.replace(/(\d+)(d)/g, (_, n, d) => `${parseInt(n) * 2}${d}`) : f);
      }
    }
    if (!hasActivities && item.system?.damage?.base) add(item.system.damage.base);
    if (!hasActivities && item.system?.damage?.versatile) add(item.system.damage.versatile);
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

  static async handleRollPuro(actor, params = {}) {
    let formula = params.formula;
    if (!formula) throw new Error('Nessuna formula specificata');

    if (params.advantage) {
      formula = formula.replace(/\b1d20\b/, '2d20kh');
    } else if (params.disadvantage) {
      formula = formula.replace(/\b1d20\b/, '2d20kl');
    }

    if (params.bonus) {
      formula += ` + ${params.bonus}`;
    }

    const roll = new Roll(formula, actor.getRollData());
    await roll.evaluate({ async: true });

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `Tiro: ${formula}`
    });

    return this._formatRoll(roll, { type: 'puro', name: formula });
  }

  static async handleShortRest(actor, options = {}) {
    const classes = actor.items.filter(i => i.type === 'class');
    if (!classes.length) throw new Error('Nessuna classe trovata');

    const hdTotal = actor.system?.attributes?.hd || 0;
    const hdUsed = actor.system?.attributes?.hdUsed || 0;
    const available = hdTotal - hdUsed;
    if (available <= 0) throw new Error('Nessun dado vita disponibile. Fai un riposo lungo per recuperarli.');

    const conMod = actor.system?.abilities?.con?.mod || 0;
    const toUse = Math.min(options.hd || available, available);

    const sizes = classes.map(c => parseInt((c.system?.hitDice || 'd6').replace('d', '')));
    const dieSize = Math.max(...sizes);

    let totalHeal = 0;
    const rollResults = [];

    for (let i = 0; i < toUse; i++) {
      const r = new Roll(`1d${dieSize} + ${conMod}`, actor.getRollData());
      await r.evaluate({ async: true });
      totalHeal += r.total;
      rollResults.push(r.total);
      await r.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `Riposo Breve — Dado Vita (d${dieSize})`
      });
    }

    const currentHp = actor.system?.attributes?.hp?.value || 0;
    const maxHp = actor.system?.attributes?.hp?.max || 0;
    const newHp = Math.min(currentHp + totalHeal, maxHp);

    await actor.update({
      'system.attributes.hp.value': newHp,
      'system.attributes.hdUsed': hdUsed + toUse,
    });

    return {
      success: true,
      hdUsed: toUse,
      hdRemaining: available - toUse,
      hdTotal,
      hdDieSize: dieSize,
      totalHeal,
      rolls: rollResults,
      hp: { old: currentHp, new: newHp, max: maxHp },
    };
  }

  static async handleLongRest(actor) {
    const maxHp = actor.system?.attributes?.hp?.max || 0;
    const currentHp = actor.system?.attributes?.hp?.value || 0;
    const healed = maxHp - currentHp;

    await actor.update({
      'system.attributes.hp.value': maxHp,
      'system.attributes.hdUsed': 0,
      'system.attributes.death.failure': 0,
      'system.attributes.death.success': 0,
    });

    const spells = actor.system?.spells || {};
    const slotUpdates = {};
    for (const [key, val] of Object.entries(spells)) {
      if (key.startsWith('spell') && val?.max !== undefined) {
        slotUpdates[`system.spells.${key}.value`] = val.max;
      }
    }
    if (Object.keys(slotUpdates).length) {
      await actor.update(slotUpdates);
    }

    return {
      success: true,
      hpHealed: healed,
      hp: { old: currentHp, new: maxHp, max: maxHp },
      hdRecovered: actor.system?.attributes?.hd || 0,
    };
  }

  static async handleDeathSave(actor) {
    const roll = new Roll('1d20');
    await roll.evaluate({ async: true });
    const total = roll.total;

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `Tiro Salvezza Morte`
    });

    const death = actor.system?.attributes?.death || {};
    let failures = death.failure || 0;
    let successes = death.success || 0;
    let result = '';

    if (total === 20) {
      result = 'RIPRESO! Torna in piedi con 1 PF.';
      await actor.update({
        'system.attributes.hp.value': 1,
        'system.attributes.death.failure': 0,
        'system.attributes.death.success': 0,
      });
    } else if (total === 1) {
      failures += 2;
      result = `CROLLO! Subisci 2 fallimenti (${failures}/3).`;
      await actor.update({ 'system.attributes.death.failure': failures });
    } else if (total >= 10) {
      successes += 1;
      result = `Successo! (${successes}/3)`;
      await actor.update({ 'system.attributes.death.success': successes });
    } else {
      failures += 1;
      result = `Fallimento! (${failures}/3)`;
      await actor.update({ 'system.attributes.death.failure': failures });
    }

    if (failures >= 3) result = '⚠️ **MUORI!** 3 fallimenti nei tiri salvezza morte.';
    if (successes >= 3) result = '✅ **Stabilizzato!** 3 successi nei tiri salvezza morte.';

    return {
      success: true,
      roll: total,
      result,
      failures,
      successes,
    };
  }

  static async handleRollConcentration(actor, options = {}) {
    const damage = options.damage || 0;
    const dc = Math.max(10, Math.floor(damage / 2));

    const ability = actor.system?.abilities?.con;
    const modifier = ability?.save?.value ?? ability?.save ?? ability?.mod ?? 0;

    const roll = new Roll(`1d20 + ${modifier}`, actor.getRollData());
    await roll.evaluate({ async: true });

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `Concentrazione (DC ${dc}, danno: ${damage})`
    });

    const passed = roll.total >= dc;

    return {
      success: true,
      roll: roll.total,
      dc,
      damage,
      modifier,
      passed,
      result: passed ? 'Concentrazione mantenuta' : 'Concentrazione persa!',
    };
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
