import {Controller, OnModuleInit} from '@nestjs/common';
import {CommitsService} from "./commits.service";
import {AmplicationLogger} from "@amplication/nest-logger-module";
import {CommitContext} from "./dto/commit-context.dto";
import {DiffService} from "../diff";
import {PrModule} from "../../constants";
import {CommitStateDto, KafkaConsumer, KafkaMessageDto, KafkaProducer} from "@amplication/kafka";





class GitCommitInitiatedDto {
  public commit: { id: string, message: string }
  public build: { id: string, actionStepId:string, resourceId:string, previousBuildId: string }
  public repository: { owner: string, name: string, installationId: string }
}

@Controller()
export class CommitController implements OnModuleInit {


  public static readonly TOPIC = "git.internal.create-commit.request.0"
  public static readonly CREATED_TOPIC = "git.internal.commit-state.request.0"

  constructor(private kafkaConsumer: KafkaConsumer<string, GitCommitInitiatedDto>,
              private kafkaProducer: KafkaProducer<string, CommitStateDto>,
              private commitService: CommitsService,
              private diffService: DiffService,
              private logger: AmplicationLogger) {
  }

  async onModuleInit(): Promise<any> {
    this.logger.info(`CommitController - subscribing to topic: ${CommitController.TOPIC}`)
    await this.kafkaConsumer.subscribe(CommitController.TOPIC, this.handleCommit)
  }

  async handleCommit(kafkaMessage: KafkaMessageDto<string, GitCommitInitiatedDto>): Promise<void> {
    try {
      this.logger.info("CommitController - received message from topic", {
        ...kafkaMessage
      })
      const eventData = kafkaMessage.value

      this.logger.info("get changed files from last build", {
        ...eventData
      })
      const changedFiles: PrModule[] = await this.diffService.listOfChangedFiles(
          eventData.build.resourceId,
          eventData.build.previousBuildId,
          eventData.build.id
      )
      this.logger.info(
          'The changed files has return from the diff service listOfChangedFiles',
          {
            ...eventData,
            lengthOfFile: changedFiles.length
          }
      );

      const commitContext: CommitContext = CommitController.createCommitContext(eventData)


      const commitSha: string = await this.commitService.addCommitToRepository(eventData.repository.installationId,
          commitContext, eventData.commit.message, changedFiles.map(({path, code}) => ({
            path,
            content: code
          })))

      await this.kafkaProducer.emit(CommitController.CREATED_TOPIC, commitContext.buildId,
          new CommitStateDto(eventData.build.actionStepId, `Commit ${commitSha} pushed successfully to ${eventData.repository.owner}/${eventData.repository.name}`, "Success", {
            commitSha
          }))
    } catch (error) {
      await this.kafkaProducer.emit(CommitController.CREATED_TOPIC, kafkaMessage.value.build.id,
          new CommitStateDto(kafkaMessage.value.build.actionStepId,error.message, "Failed"))
    }
  }

  private static createCommitContext(value: GitCommitInitiatedDto): CommitContext {
    return {
      owner: value.repository.owner,
      commitId: value.commit.id,
      repo: value.repository.name,
      resourceName: value.build.resourceId,
      resourceId: value.build.resourceId,
      buildId: value.build.id,
      actionStepId: value.build.actionStepId
    }
  }
}