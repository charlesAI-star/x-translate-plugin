function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

export function validateJsonSchema(value, schema, at = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];
  const expected = schema.type;

  if (expected) {
    const types = Array.isArray(expected) ? expected : [expected];
    const actual = typeOf(value);
    const ok = types.some((type) => {
      if (type === 'number') return actual === 'number' || actual === 'integer';
      return type === actual;
    });
    if (!ok) {
      errors.push(`${at} 应为 ${types.join('|')}，实际为 ${actual}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at} 的值不在允许范围内`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at} 长度小于 ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${at} 长度大于 ${schema.maxLength}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} 小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at} 大于 ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at} 至少需要 ${schema.minItems} 项`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${at} 最多允许 ${schema.maxItems} 项`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateJsonSchema(item, schema.items, `${at}[${index}]`));
      });
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (value[key] === undefined || value[key] === null) errors.push(`${at}.${key} 缺失`);
      }
    }
    if (schema.properties) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (value[key] !== undefined) {
          errors.push(...validateJsonSchema(value[key], child, `${at}.${key}`));
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in schema.properties)) errors.push(`${at}.${key} 是未允许的字段`);
        }
      }
    }
  }

  return errors;
}
