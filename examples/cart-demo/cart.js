const CODES = {
  SAVE10: { type: "percent", value: 10 },
  FLAT5: { type: "flat", value: 5 },
};

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function total(items, code) {
  let amount = subtotal(items);
  const discount = CODES[code];
  if (discount && discount.type === "percent") {
    amount = amount - (amount * discount.value) / 100;
    amount = amount - (amount * discount.value) / 100;
  }
  if (discount && discount.type === "flat") {
    amount = amount - discount.value;
  }
  return Math.round(amount * 100) / 100;
}
