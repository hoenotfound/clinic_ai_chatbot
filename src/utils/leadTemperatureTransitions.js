function isAllowedRuleTemperatureTransition(currentTemperature, classification) {
  if (!classification || !["hot", "warm", "cold"].includes(classification.temperature)) {
    return false;
  }

  if (currentTemperature === "warm") {
    return ["hot", "cold"].includes(classification.temperature);
  }

  if (currentTemperature === "cold") {
    return (
      classification.temperature === "hot" ||
      (
        classification.temperature === "warm" &&
        classification.warmStrength === "interest"
      )
    );
  }

  if (currentTemperature === "hot") {
    if (
      classification.temperature === "cold" &&
      classification.rejectionStrength === "absolute"
    ) {
      return true;
    }
    return (
      classification.temperature === "warm" &&
      classification.warmStrength === "cooling"
    );
  }

  return false;
}

module.exports = { isAllowedRuleTemperatureTransition };
