// Synthetic origins for isolated test processes; never imported by application code.
process.env.GATEWAY_API_ORIGIN = 'https://api.inference.invalid';
process.env.GATEWAY_EVIDENCE_ORIGINS = JSON.stringify([
  'https://inference.invalid',
  'https://www.inference.invalid',
]);
