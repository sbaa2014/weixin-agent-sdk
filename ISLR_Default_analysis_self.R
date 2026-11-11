# ISLR::Default 分析：基础手写版

if (!requireNamespace("ISLR", quietly = TRUE)) install.packages("ISLR")
data(Default, package = "ISLR")
Default$default01 <- ifelse(Default$default == "Yes", 1, 0)

cat("样本量：", nrow(Default), "\n")
print(table(Default$default))
cat("总体违约率：", mean(Default$default01), "\n")
print(prop.table(table(Default$default)))

cat("\nstudent 与 default 的列联表及条件违约率：\n")
print(table(Default$student, Default$default))
print(with(Default, tapply(default01, student, mean)))
cat("\n各 default 组的 balance/income 描述统计：\n")
print(aggregate(cbind(balance, income) ~ default, data = Default,
                FUN = function(x) c(mean = mean(x), median = median(x), sd = sd(x))))

cat("\n一元 logistic 回归：\n")
m_student <- glm(default ~ student, data = Default, family = binomial)
m_balance <- glm(default ~ balance, data = Default, family = binomial)
m_income  <- glm(default ~ income,  data = Default, family = binomial)
print(summary(m_student)); print(summary(m_balance)); print(summary(m_income))
cat("\n一元模型的优势比 exp(coef)：\n")
print(rbind(student = exp(coef(m_student)), balance = exp(coef(m_balance)),
            income = exp(coef(m_income))))

cat("\n多元 logistic 回归：\n")
m_full <- glm(default ~ student + balance + income, data = Default, family = binomial)
print(summary(m_full))
print(exp(cbind(OR = coef(m_full), confint(m_full))))

new_applicant <- data.frame(student = factor("Yes", levels = levels(Default$student)),
                            balance = 2500, income = 50000)
cat("\n申请者预测违约概率：\n")
print(predict(m_full, newdata = new_applicant, type = "response"))

set.seed(123)
n <- nrow(Default)
train_id <- sample(seq_len(n), size = floor(.70 * n))
train <- Default[train_id, ]; test <- Default[-train_id, ]
candidate <- glm(default ~ student + balance + income, data = train, family = binomial)
if (requireNamespace("MASS", quietly = TRUE)) {
  best <- MASS::stepAIC(candidate, direction = "both", trace = FALSE)
} else best <- candidate
cat("\n训练集上按 AIC 选择的模型：\n"); print(formula(best))

predict_and_report <- function(model, dat) {
  p <- predict(model, newdata = dat, type = "response")
  pred <- ifelse(p >= .5, "Yes", "No")
  print(table(Actual = dat$default, Predicted = pred))
  cat("accuracy =", mean(pred == dat$default), "\n")
}
cat("训练集：\n"); predict_and_report(best, train)
cat("测试集：\n"); predict_and_report(best, test)
