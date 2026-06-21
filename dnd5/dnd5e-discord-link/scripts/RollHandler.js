export class RollHandler {
  static async handleRollSkill(actor, skillId) {
    const skill = actor.system?.skills?.[skillId];
    if (!skill) throw new Error(`Skill ${skillId} not found`);

    const result = await actor.rollSkill({ skill: skillId }, { configure: false }, { create: false });
    const roll = Array.isArray(result) ? result[0] : result;
    return this._formatRoll(roll, { type: 'skill', name: skillId });
  }

  static async handleRollAbility(actor, abilityId) {
    const result = await actor.rollAbilityCheck({ ability: abilityId }, { configure: false }, { create: false });
    const roll = Array.isArray(result) ? result[0] : result;
    return this._formatRoll(roll, { type: 'ability', name: abilityId });
  }

  static async handleRollSave(actor, abilityId) {
    const result = await actor.rollSavingThrow({ ability: abilityId }, { configure: false }, { create: false });
    const roll = Array.isArray(result) ? result[0] : result;
    return this._formatRoll(roll, { type: 'save', name: abilityId });
  }

  static async handleRollAttack(actor, itemId) {
    const item = actor.items.get(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);

    let roll;
    if (typeof item.rollAttack === 'function') {
      roll = await item.rollAttack();
    } else {
      const activity = item.system.activities?.find(a => a.type === 'attack');
      if (activity) {
        const result = await activity.rollAttack({}, { configure: false }, { create: false });
        roll = result?.[0];
      } else {
        throw new Error('Questo oggetto non supporta tiri per colpire');
      }
    }
    return this._formatRoll(roll, { type: 'attack', name: item.name });
  }

  static async handleRollDamage(actor, itemId, critical = false) {
    const item = actor.items.get(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);

    let roll;
    if (typeof item.rollDamage === 'function') {
      roll = await item.rollDamage({ critical });
    } else {
      const activity = item.system.activities?.find(a => a.type === 'damage' || a.type === 'attack');
      if (activity) {
        const result = await activity.rollDamage({ critical }, { configure: false }, { create: false });
        roll = result?.[0];
      } else {
        throw new Error('Questo oggetto non supporta tiri danno');
      }
    }
    return this._formatRoll(roll, { type: 'damage', name: item.name });
  }

  static _formatRoll(roll, meta = {}) {
    if (!roll) {
      return { error: 'Roll failed to execute', meta };
    }

    return {
      success: true,
      formula: roll.formula,
      total: roll.total,
      result: roll.result,
      dice: roll.terms?.map(t => ({
        type: t.constructor.name,
        faces: t.faces,
        number: t.number,
        results: t.results?.map(r => r.result) || [],
        total: t.total,
      })) || [],
      meta,
    };
  }
}
