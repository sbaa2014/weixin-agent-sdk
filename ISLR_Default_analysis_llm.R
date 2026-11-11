# ISLR::Default 分析：函数化/可复用版（大模型写法示例）

if (!requireNamespace("ISLR", quietly = TRUE)) install.packages("ISLR")
library(ISLR)

odds_ratio <- function(model) {
  b <- coef(model)
  data.frame(term = names(b), estimate = b, odds_ratio = exp(b),
             p_value = summary(model)$coefficients[, 4], row.names = NULL)
}
accuracy <- function(model, dat, cutoff = .5) {
  p <- predict(model, newdata = dat, type = "response")
  pred <- factor(ifelse(p >= cutoff, "Yes", "No"), levels = c("No", "Yes"))
  actual <- factor(dat$default, levels = c("No", "Yes"))
  list(confusion = table(Actual = actual, Predicted = pred),
       accuracy = mean(pred == actual))
}

data(Default)
Default$default01 <- as.integer(Default$default == "Yes")
cat("n =", nrow(Default), "\n")
cat("违约率 =", mean(Default$default01), "\n")
print(with(Default, prop.table(table(student, default), margin = 1)))
print(with(Default, aggregate(cbind(balance, income) ~ default,
                             FUN = function(z) c(mean = mean(z), sd = sd(z)))))

univariate <- lapply(c("student", "balance", "income"), function(x)
  glm(reformulate(x, response = "default"), data = Default, family = binomial))
names(univariate) <- c("student", "balance", "income")
invisible(lapply(univariate, function(m) print(odds_ratio(m))))

full <- glm(default ~ student + balance + income, data = Default, family = binomial)
print(summary(full)); print(odds_ratio(full))
applicant <- data.frame(student = factor("Yes", levels = levels(Default$student)),
                        balance = 2500, income = 50000)
cat("申请者预测概率：", predict(full, applicant, type = "response"), "\n")

set.seed(123)
idx <- sample.int(nrow(Default), floor(.7 * nrow(Default)))
train <- Default[idx, , drop = FALSE]; test <- Default[-idx, , drop = FALSE]
selected <- glm(default ~ student + balance + income, data = train, family = binomial)
if (requireNamespace("MASS", quietly = TRUE))
  selected <- MASS::stepAIC(selected, direction = "both", trace = FALSE)
cat("最优模型：", deparse(formula(selected)), "\n")
train_result <- accuracy(selected, train); test_result <- accuracy(selected, test)
print(train_result$confusion); cat("训练集准确率：", train_result$accuracy, "\n")
print(test_result$confusion); cat("测试集准确率：", test_result$accuracy, "\n")
