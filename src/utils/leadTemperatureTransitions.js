function isAllowedRuleTemperatureTransition(currentTemperature, classification) {
  if (!classification || !["hot", "cold"].includes(classification.temperature)) {
    return false;
  }

  if (currentTemperature === "warm") return true;
  if (currentTemperature === "cold") return classification.temperature === "hot";
  if (currentTemperature === "hot") {
    return (
      classification.temperature === "cold" &&
      classification.rejectionStrength === "absolute"
    );
  }
  return false;
}

module.exports = { isAllowedRuleTemperatureTransition };
