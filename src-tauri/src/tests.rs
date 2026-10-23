use super::*;

fn sample_plan_ready() -> PlanWorkflowState {
    PlanWorkflowState::PlanReady {
        artifact: PlanArtifactState {
            path: ".axecode/plans/test.md".into(),
            absolute_path: Some("/workspace/.axecode/plans/test.md".into()),
            title: Some("Test plan".into()),
            updated_at_ms: Some(1),
        },
    }
}

#[test]
fn plan_policy_starts_question_loop_from_idle_plan_mode() {
    let policy = plan_turn_policy(&PlanWorkflowState::Idle, AgentMode::Plan, None).unwrap();

    assert_eq!(policy.mode, AgentMode::Plan);
    assert!(!policy.stop_questions);
    assert!(!policy.attach_plan);
    assert_eq!(policy.next_workflow, PlanWorkflowState::PlanningQuestions);
}

#[test]
fn plan_policy_forces_plan_mode_while_questions_are_active() {
    let policy =
        plan_turn_policy(&PlanWorkflowState::PlanningQuestions, AgentMode::Act, None).unwrap();

    assert_eq!(policy.mode, AgentMode::Plan);
    assert_eq!(policy.next_workflow, PlanWorkflowState::PlanningQuestions);
}

#[test]
fn plan_policy_only_attaches_plan_after_stop_questions() {
    let policy = plan_turn_policy(
        &PlanWorkflowState::PlanningQuestions,
        AgentMode::Plan,
        Some(PlanControlInput::StopQuestions),
    )
    .unwrap();

    assert_eq!(policy.mode, AgentMode::Plan);
    assert!(policy.stop_questions);
    assert!(policy.attach_plan);
    assert_eq!(policy.next_workflow, PlanWorkflowState::PlanningQuestions);
}

#[test]
fn plan_policy_rejects_implementation_before_plan_exists() {
    let err = plan_turn_policy(
        &PlanWorkflowState::PlanningQuestions,
        AgentMode::Act,
        Some(PlanControlInput::ImplementPlan),
    )
    .unwrap_err();

    assert!(err.contains("créez le plan"));
}

#[test]
fn plan_policy_allows_card_actions_after_manual_exit() {
    let update_policy = plan_turn_policy(
        &PlanWorkflowState::Idle,
        AgentMode::Act,
        Some(PlanControlInput::UpdatePlan),
    )
    .unwrap();
    assert_eq!(update_policy.mode, AgentMode::Plan);
    assert_eq!(
        update_policy.next_workflow,
        PlanWorkflowState::PlanningQuestions
    );

    let implement_policy = plan_turn_policy(
        &PlanWorkflowState::Idle,
        AgentMode::Act,
        Some(PlanControlInput::ImplementPlan),
    )
    .unwrap();
    assert_eq!(implement_policy.mode, AgentMode::Act);
    assert_eq!(implement_policy.next_workflow, PlanWorkflowState::Idle);
}

#[test]
fn plan_policy_rejects_act_mode_when_plan_is_ready_without_user_action() {
    let err = plan_turn_policy(&sample_plan_ready(), AgentMode::Act, None).unwrap_err();

    assert!(err.contains("choisissez de le modifier ou de l'exécuter"));
}

#[test]
fn plan_policy_allows_implementation_after_plan_is_ready() {
    let policy = plan_turn_policy(
        &sample_plan_ready(),
        AgentMode::Act,
        Some(PlanControlInput::ImplementPlan),
    )
    .unwrap();

    assert_eq!(policy.mode, AgentMode::Act);
    assert_eq!(policy.next_workflow, PlanWorkflowState::Idle);
    assert!(!policy.attach_plan);
}

#[test]
fn plan_policy_returns_to_question_loop_when_updating_ready_plan() {
    let policy = plan_turn_policy(
        &sample_plan_ready(),
        AgentMode::Plan,
        Some(PlanControlInput::UpdatePlan),
    )
    .unwrap();

    assert_eq!(policy.mode, AgentMode::Plan);
    assert_eq!(policy.next_workflow, PlanWorkflowState::PlanningQuestions);
}

#[test]
fn workflow_active_mode_returns_to_act_after_goal_completion() {
    let goal = GoalWorkflowState::Complete {
        objective: "done".into(),
        started_at_ms: 10,
        completed_at_ms: 20,
    };

    assert_eq!(
        workflow_active_mode(&PlanWorkflowState::Idle, &goal),
        AgentMode::Act
    );
}

#[test]
fn workflow_active_mode_uses_goal_only_while_goal_is_active() {
    let active_goal = GoalWorkflowState::Active {
        objective: "work".into(),
        started_at_ms: 10,
        updated_at_ms: 15,
    };
    let paused_goal = GoalWorkflowState::Paused {
        objective: "work".into(),
        started_at_ms: 10,
        updated_at_ms: 15,
    };

    assert_eq!(
        workflow_active_mode(&PlanWorkflowState::Idle, &active_goal),
        AgentMode::Goal
    );
    assert_eq!(
        workflow_active_mode(&PlanWorkflowState::Idle, &paused_goal),
        AgentMode::Act
    );
}

#[test]
fn context_estimate_stays_in_plan_mode_for_active_workflows() {
    assert_eq!(
        plan_estimate_mode(&PlanWorkflowState::PlanningQuestions, AgentMode::Act),
        AgentMode::Plan
    );
    assert_eq!(
        plan_estimate_mode(&sample_plan_ready(), AgentMode::Act),
        AgentMode::Plan
    );
}

#[test]
fn rewritable_user_message_rejects_compaction_and_hidden_messages() {
    let normal = ChatMessage {
        role: Role::User,
        parts: vec![Part::Text {
            text: "change this".into(),
            meta: None,
        }],
    };
    let retained = ChatMessage {
        role: Role::User,
        parts: vec![Part::Text {
            text: "old user message".into(),
            meta: Some(json!({ "compaction_retained_user": true })),
        }],
    };
    let summary = ChatMessage {
        role: Role::User,
        parts: vec![Part::Text {
            text: "summary".into(),
            meta: Some(json!({ "compaction_summary": true })),
        }],
    };
    let reminder = ChatMessage {
        role: Role::User,
        parts: vec![Part::Text {
            text: "continue".into(),
            meta: Some(json!({ "system_reminder": true })),
        }],
    };

    assert!(is_rewritable_user_message(&normal));
    assert!(!is_rewritable_user_message(&retained));
    assert!(!is_rewritable_user_message(&summary));
    assert!(!is_rewritable_user_message(&reminder));
}

#[test]
fn plan_implementation_reminder_uses_ready_plan_artifact() {
    let reminder = plan_implementation_turn_reminder(
        Path::new("/workspace"),
        &sample_plan_ready(),
        &[],
        Some(PlanControlInput::ImplementPlan),
    )
    .unwrap()
    .unwrap();

    assert!(reminder.contains("Plan path: .axecode/plans/test.md"));
    assert!(reminder.contains("Plan title: Test plan"));
    assert!(reminder.contains("current turn"));
    assert!(reminder.contains("Use the ToDoList tool"));
}

#[test]
fn plan_implementation_reminder_uses_attached_plan_after_context_clear() {
    let attachments = vec![AttachmentInput {
        path: "/workspace/.axecode/plans/fresh.md".into(),
        name: Some("fresh.md".into()),
    }];
    let reminder = plan_implementation_turn_reminder(
        Path::new("/workspace"),
        &PlanWorkflowState::Idle,
        &attachments,
        Some(PlanControlInput::ImplementPlan),
    )
    .unwrap()
    .unwrap();

    assert!(reminder.contains("Plan path: .axecode/plans/fresh.md"));
}

#[test]
fn plan_implementation_reminder_is_scoped_to_implement_control() {
    let reminder = plan_implementation_turn_reminder(
        Path::new("/workspace"),
        &sample_plan_ready(),
        &[],
        Some(PlanControlInput::UpdatePlan),
    )
    .unwrap();

    assert!(reminder.is_none());
}
